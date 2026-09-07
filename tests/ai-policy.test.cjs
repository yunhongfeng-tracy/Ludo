'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../src/engine.js');
const Classic = require('../src/ai.js');
const Combined = require('../src/ai-v2-combined.js');
const Policy = require('../src/ai-policy.js');
const { strategySources } = require('../tools/ai-product-sources.cjs');
const { build } = require('../tools/build.cjs');

function fixture(red, yellow, die = 3) {
  return E.applyRoll({ ...E.createGame(0), tokenProgress: [red.slice(), yellow.slice()] }, die);
}
function stable(result) {
  const { elapsedMs, ...diagnostics } = result.diagnostics;
  return { ...result, diagnostics };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('产品入口保留Classic全部旧辅助API，终极配置直接引用组合模块单一来源', () => {
  for (const [name, member] of Object.entries(Classic)) {
    if (typeof member === 'function' && name !== 'chooseAction') assert.equal(Policy[name], member, name);
  }
  assert.equal(Policy.LEVEL_CONFIGS.advanced, Classic.LEVEL_CONFIGS.advanced);
  assert.equal(Policy.LEVEL_CONFIGS.ultimate, Combined.DEFAULT_CONFIG);
  assert.ok(Object.isFrozen(Policy.LEVEL_CONFIGS.ultimate));
  assert.equal(Policy.LEVEL_VERSIONS.advanced.strategy, Classic.STRATEGY_VERSION);
  assert.equal(Policy.LEVEL_VERSIONS.ultimate.strategy, Combined.STRATEGY_VERSION);
  assert.match(Policy.STRATEGY_VERSION, /ultimate-v2/);
  assert.ok(!Policy.EVALUATION_VERSION.includes('undefined'));
});

test('前三档与Classic动作、分数、节点诊断、随机流消费完全一致', () => {
  const states = [
    fixture([8, 20, -1, 55], [4, 19, 36, 54], 6),
    fixture([15, 29, 42, 51], [10, 22, 38, 50], 3),
    fixture([54, 55, 56, 56], [53, 55, 56, 56], 1),
    fixture([-1, -1, -1, -1], [-1, -1, -1, -1], 6)
  ];
  for (const difficulty of ['beginner', 'medium', 'advanced', undefined]) {
    for (const state of states) {
      const rng1 = Classic.createSeededRng('policy-regression');
      const rng2 = Classic.createSeededRng('policy-regression');
      const options = { budgetMs: Infinity, maxNodes: 400, maxDepth: 3 };
      assert.deepEqual(stable(Policy.chooseAction(state, difficulty, rng1, options)),
        stable(Classic.chooseAction(state, difficulty, rng2, options)));
      assert.equal(rng1(), rng2());
    }
  }
  assert.throws(() => Policy.chooseAction(states[0], 'invented'), /Difficulty/);
});

test('产品终极调用组合策略，精确残局与常规搜索结果均保留', () => {
  const endgame = fixture([54, 55, 56, 56], [53, 55, 56, 56], 1);
  const exact = Policy.chooseAction(endgame, 'ultimate', undefined, { budgetMs: Infinity });
  assert.equal(exact.diagnostics.strategyVersion, Combined.STRATEGY_VERSION);
  assert.equal(exact.diagnostics.exact, true);
  assert.ok(exact.probability >= 0 && exact.probability <= 1);
  const normal = fixture([12, 30, -1, 55], [10, 20, -1, 54], 3);
  const result = Policy.chooseAction(normal, 'ultimate', undefined, { budgetMs: Infinity, maxNodes: 200 });
  assert.equal(result.diagnostics.exact, false);
  assert.equal(result.probability, null);
  assert.ok(E.getLegalActions(normal).includes(result.action));
});

test('实际构建的主页面与Worker含同一依赖拓扑，并使用同一产品版本完成请求', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ludo-policy-bundle-'));
  try {
    const file = path.join(directory, 'preview.html');
    const output = build(file);
    const html = fs.readFileSync(file, 'utf8');
    assert.deepEqual(output.strategyFiles, strategySources());
    assert.equal(output.strategyFiles.at(-1), 'src/ai-policy.js');
    assert.equal(new Set(output.strategyFiles).size, output.strategyFiles.length);
    assert.ok(output.strategyFiles.includes('src/ai-v2-endgame.js'));
    assert.ok(!output.strategyFiles.includes('src/ai-v2-rollout.js'), '未选中的rollout开发候选不打进产品');
    assert.ok(!html.includes('\uFFFD'));
    assert.ok(!/<script[^>]+src\s*=/i.test(html));
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    const workerSource = scripts.find(match => match[1].includes('ai-worker-source'))[2];
    const mainScripts = scripts.filter(match => !match[1].includes('text/plain') &&
      (match[2].includes('root.LudoEngine = api') || match[2].includes('four-level-ultimate-v2@1')));
    assert.equal(mainScripts.length, 2);
    const main = vm.createContext({ performance: { now: () => 0 } });
    for (const script of mainScripts) vm.runInContext(script[2], main, { timeout: 3000 });
    const messages = [];
    const worker = vm.createContext({ performance: { now: () => 0 }, postMessage: message => messages.push(message) });
    worker.self = worker;
    vm.runInContext(workerSource, worker, { timeout: 3000 });
    assert.equal(main.LudoAI.STRATEGY_VERSION, Policy.STRATEGY_VERSION);
    assert.equal(worker.LudoAI.EVALUATION_VERSION, Policy.EVALUATION_VERSION);
    assert.equal(messages[0].type, 'ready');
    const state = fixture([55, 56, 56, 56], [53, 55, 56, 56], 1);
    const identity = { requestId: 1, gameId: 1, stateRevision: 2, difficulty: 'ultimate',
      strategyVersion: main.LudoAI.STRATEGY_VERSION, evaluationVersion: main.LudoAI.EVALUATION_VERSION,
      rulesetId: state.rulesetId, boardVersion: state.boardVersion };
    worker.onmessage({ data: { type: 'choose', state, ...identity } });
    assert.equal(messages.at(-1).type, 'result');
    assert.deepEqual(plain(messages.at(-1).result), plain(main.LudoAI.chooseAction(state, 'ultimate')));
    worker.onmessage({ data: { type: 'choose', state, ...identity, strategyVersion: 'old-worker-version' } });
    assert.equal(messages.at(-1).type, 'failure');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
