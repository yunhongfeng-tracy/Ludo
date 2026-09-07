'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../src/engine.js');
const Policy = require('../src/ai-policy.js');
const Combined = require('../src/ai-v2-combined.js');
const B = require('../tools/ai-benchmark.cjs');

function spec(options = {}) {
  return { mode: 'development', execution: 'nodes', seed: 'benchmark-unit-only', blocks: 1, maxRolls: 10000, pairs: ['beginner-medium'], ...options };
}
function manifest(options = {}) { return B.buildManifest(spec(options), { sources: { fixture: 'unit-test-source' } }); }
const firstLegalAI = { chooseAction(state) { return { action: E.getLegalActions(state)[0], diagnostics: { completedDepth: 0, stopReason: 'test-policy' } }; } };
function withDirectory(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ludo-benchmark-test-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('每块四局覆盖高档双方阵营与先后手，块内骰序列配对且策略流隔离', () => {
  const schedule = B.makeSchedule(spec({ blocks: 2, pairs: B.PAIRS }));
  assert.equal(schedule.length, 24);
  for (const pair of B.PAIRS) for (let block = 0; block < 2; block += 1) {
    const group = schedule.filter(game => game.pair === pair && game.block === block);
    assert.equal(new Set(group.map(game => game.judgeSeed)).size, 1);
    assert.equal(new Set(group.map(game => game.highPlayer + ':' + (game.highPlayer === game.firstPlayer))).size, 4);
    assert.ok(group.every(game => game.policySeeds.every(seed => seed !== game.judgeSeed)));
    assert.equal(new Set(group.flatMap(game => game.policySeeds)).size, 8);
  }
  assert.equal(new Set(schedule.map(game => game.judgeSeed)).size, 6);
});

test('改变策略随机消费次数不改变裁判骰序列，开发与留出种子域不同', () => {
  function sample(extra) {
    const game = B.makeSchedule(spec())[0];
    const dice = B.diceRng(game.judgeSeed);
    const strategy = B.policyRng(game.policySeeds[0]);
    return Array.from({ length: 100 }, () => {
      for (let i = 0; i < extra; i += 1) strategy();
      return dice();
    });
  }
  assert.deepEqual(sample(0), sample(90));
  assert.ok(sample(0).every(die => Number.isInteger(die) && die >= 1 && die <= 6));
  assert.notEqual(B.makeSchedule(spec())[0].judgeSeed, B.makeSchedule(spec({ mode: 'holdout' }))[0].judgeSeed);
});

test('manifest冻结配置与源码，参数篡改和源码变化均拒绝续跑', () => {
  const m = manifest();
  assert.equal(B.verifyManifest(m, m.sources), true);
  assert.throws(() => B.verifyManifest({ ...m, maxRolls: m.maxRolls + 1 }, m.sources), /content\/hash mismatch/);
  assert.throws(() => B.verifyManifest(m, { fixture: 'changed' }), /Source\/protocol hashes changed/);
  assert.throws(() => manifest({ pairs: ['beginner-medium', 'beginner-medium'] }), /distinct adjacent/);
  assert.throws(() => manifest({ mode: 'holdout' }), /all three/);
});

test('同种子与节点配置重放动作和终局摘要一致，墙钟耗时不参与对局摘要', () => {
  const m = manifest();
  const runtime = { engine: E, ai: firstLegalAI };
  const a = B.runGame(m, m.games[0], runtime);
  const b = B.runGame(m, m.games[0], runtime);
  assert.equal(a.status, 'finished');
  assert.equal(a.traceSha256, b.traceSha256);
  assert.equal(a.rolls, b.rolls);
  assert.equal(a.winner, b.winner);
  assert.deepEqual(a.finalState, b.finalState);
});

test('非法动作和状态修改均保存为正确性错误，不作为一盘输棋', () => {
  const m = manifest();
  const illegal = B.runGame(m, m.games[0], { engine: E, ai: { chooseAction() { return { action: 9 }; } } });
  assert.equal(illegal.status, 'error');
  assert.equal(illegal.highScore, null);
  assert.match(illegal.failure.message, /illegal action/);
  const mutated = B.runGame(m, m.games[0], { engine: E, ai: { chooseAction(state) { state.tokenProgress[0][0] = 12; return { action: 0 }; } } });
  assert.equal(mutated.status, 'error');
  assert.match(mutated.failure.message, /mutated/);
});

test('到保护上限保留截断，不记平局，不从计划分母删除', () => {
  const m = manifest({ maxRolls: 1 });
  const row = B.runGame(m, m.games[0], { engine: E, ai: firstLegalAI });
  assert.equal(row.status, 'truncated');
  assert.equal(row.highScore, null);
  const report = B.summarize(m, [row]);
  const pair = report.pairs['beginner-medium'];
  assert.equal(pair.truncated, 1);
  assert.equal(pair.requestedGames, 4);
  assert.equal(pair.thresholdsMet, false);
  assert.deepEqual(pair.sensitivityAcrossAllPlannedGames, { allUnfinishedLose: 0, allUnfinishedWin: 1 });
});

test('逐局检查点可恢复，写入中断的末行单独归档，已完成行不重跑', () => withDirectory(dir => {
  const m = manifest();
  const row = B.runGame(m, m.games[0], { engine: E, ai: firstLegalAI });
  const file = path.join(dir, 'games.jsonl');
  B.appendDurably(file, row);
  fs.appendFileSync(file, '{"manifestId":"interrupted', 'utf8');
  assert.throws(() => B.loadCheckpoint(dir, m), /incomplete final line/);
  const recovered = B.loadCheckpoint(dir, m, true);
  assert.deepEqual(recovered, [row]);
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('checkpoint-tail.')));
  assert.equal(fs.readFileSync(path.join(dir, 'recovery.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  assert.deepEqual(B.loadCheckpoint(dir, m), [row]);
}));

test('检查点重复局、错manifest和改写获胜方均拒绝，不默默选最后一条', () => withDirectory(dir => {
  const m = manifest();
  const row = B.runGame(m, m.games[0], { engine: E, ai: firstLegalAI });
  const file = path.join(dir, 'games.jsonl');
  B.appendDurably(file, row); B.appendDurably(file, row);
  assert.throws(() => B.loadCheckpoint(dir, m), /Duplicate/);
  fs.writeFileSync(file, JSON.stringify({ ...row, manifestId: 'wrong' }) + '\n', 'utf8');
  assert.throws(() => B.loadCheckpoint(dir, m), /different manifest/);
  fs.writeFileSync(file, JSON.stringify({ ...row, highScore: 1 - row.highScore }) + '\n', 'utf8');
  assert.throws(() => B.loadCheckpoint(dir, m), /record hash mismatch/);
}));

test('块级Hoeffding下界采用预注册单侧alpha/3，小样本完胜也不声称通过', () => {
  const one = B.blockInterval([1]);
  assert.equal(one.lowerBound, 0);
  const many = B.blockInterval(Array(400).fill(0.75));
  assert.equal(many.mean, 0.75);
  assert.ok(Math.abs(many.radius - Math.sqrt(Math.log(60) / 800)) < 1e-12);
  assert.ok(many.lowerBound > 0.5);
  assert.equal(B.blockInterval([]).lowerBound, null);
  assert.throws(() => B.blockInterval([1.1]), /\[0, 1\]/);
});

test('正式留出未跑满时隐藏分数，开发集满足数值门槛也不生成正式结论', () => {
  const held = manifest({ mode: 'holdout', pairs: B.PAIRS });
  const partial = B.summarize(held, []);
  assert.equal(partial.pairs['beginner-medium'].scoresHiddenUntilPlannedEnd, true);
  assert.equal(Object.hasOwn(partial.pairs['beginner-medium'], 'highWins'), false);
  const m = manifest({ blocks: 30 });
  const rows = m.games.map(game => ({ assignment: game, status: 'finished', highScore: 1, decisions: {}, elapsedMs: 1 }));
  const report = B.summarize(m, rows);
  assert.equal(report.pairs['beginner-medium'].thresholdsMet, true);
  assert.equal(report.strengthAcceptance, false);
  assert.equal(report.fourLevelReleaseAcceptance, false);
});

test('评测冻结实际产品facade的全部策略依赖与组合默认配置', () => {
  const m = B.buildManifest(spec());
  for (const file of ['src/ai-policy.js', 'src/ai.js', 'src/ai-v2-combined.js',
    'src/ai-v2-endgame.js', 'src/ai-v2-eval.js', 'src/ai-v2-hybrid-eval.js',
    'src/ai-v2-search.js', 'src/ai-v2-hybrid-search.js', 'tools/ai-product-sources.cjs']) {
    assert.match(m.sources[file], /^[a-f0-9]{64}$/, file);
  }
  assert.equal(Object.hasOwn(m.sources, 'src/ai-v2-rollout.js'), false);
  const actualDependencies = new Set();
  function collect(file) {
    if (actualDependencies.has(file)) return;
    actualDependencies.add(file);
    for (const child of require.cache[file].children) collect(child.filename);
  }
  collect(require.resolve('../src/ai-policy.js'));
  for (const file of actualDependencies) {
    const relative = path.relative(path.resolve(__dirname, '..'), file).split(path.sep).join('/');
    assert.match(m.sources[relative], /^[a-f0-9]{64}$/, relative);
  }
  assert.deepEqual(m.config.ultimate, Combined.DEFAULT_CONFIG);
  assert.equal(m.versions.strategy, Policy.STRATEGY_VERSION);
  assert.deepEqual(m.versions.levels, Policy.LEVEL_VERSIONS);
  assert.equal(B.verifyManifest(m), true);
});

test('产品评测配置校验支持搜索类型及残局额度，拒绝未知键与非有限清单', () => {
  const resolved = B.resolveConfig({ ultimate: { searchProfile: 'hybrid', endgameBudgetMs: 0, maxEndgameStates: 0 } });
  assert.equal(resolved.ultimate.searchProfile, 'hybrid');
  assert.equal(resolved.ultimate.endgameBudgetMs, 0);
  assert.throws(() => B.resolveConfig({ ultimate: { searchProfile: 'invented' } }), /searchProfile/);
  assert.throws(() => B.resolveConfig({ ultimate: { endgameBudgetMs: Infinity } }), /finite/);
  assert.throws(() => B.resolveConfig({ ultimate: { hiddenRule: true } }), /Unknown configuration/);
  assert.throws(() => B.resolveConfig({ medium: { budgetMs: 600 } }), /Unknown configuration/);
  assert.throws(() => B.resolveConfig({ ultimate: null }), /object/);
});

test('节点执行禁用两阶段墙钟但保留状态额度，显式禁用残局不会被重新启用', () => {
  for (const disabled of [false, true]) {
    const m = manifest({ pairs: ['advanced-ultimate'], maxRolls: 100,
      config: { ultimate: { endgameBudgetMs: disabled ? 0 : 120, maxEndgameStates: 37 } } });
    let observed = 0;
    const row = B.runGame(m, m.games[0], { engine: E, ai: { chooseAction(state, level, rng, options) {
      assert.equal(options.budgetMs, Infinity);
      if (level === 'ultimate') {
        observed += 1;
        assert.equal(options.endgameBudgetMs, disabled ? 0 : Infinity);
        assert.equal(options.maxEndgameStates, 37);
      }
      return firstLegalAI.chooseAction(state);
    } } });
    assert.notEqual(row.status, 'error', row.failure?.message);
    assert.ok(observed > 0);
  }
});
