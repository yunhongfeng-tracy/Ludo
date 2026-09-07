'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../src/engine.js');
const Classic = require('../src/ai.js');
const Completion = require('../src/ai-v2-search.js');
const Hybrid = require('../src/ai-v2-hybrid-search.js');
const Combined = require('../src/ai-v2-combined.js');

function position(home = false) {
  const state = E.createGame();
  state.tokenProgress = home ? [[53, 55, 56, 56], [54, 55, 56, 56]] : [[2, 9, -1, -1], [14, 22, -1, -1]];
  return E.applyRoll(state, 1);
}
function harness(settings = {}) {
  let clock = 0;
  const calls = [];
  const result = state => ({ action: E.getLegalActions(state)[0], score: 0.2, reason: 'test', diagnostics: { visitedNodes: 7, completedDepth: 2, stopReason: 'node-budget' } });
  const search = name => ({ chooseAction(state, rng, options) { calls.push({ name, options }); clock += settings.searchMs || 10; return result(state); } });
  const sandbox = {
    performance: { now: () => clock }, LudoEngine: E,
    LudoAI: { chooseAction(state, level, rng, options) { calls.push({ name: 'classic', level, options }); clock += settings.staticMs || 2; return result(state); } },
    LudoV2Search: search('completion'), LudoV2HybridSearch: search('hybrid'),
    LudoV2Endgame: {
      canSolve: state => state.tokenProgress.every(tokens => tokens.every(progress => progress >= 51)),
      analyze(state, options) {
        calls.push({ name: 'endgame', options }); clock += settings.endgameMs || 40;
        const complete = settings.exact === true;
        return { complete, action: complete ? E.getLegalActions(state)[0] : null, score: complete ? 0.7 : null, probability: complete ? 0.7 : null,
          diagnostics: { visitedNodes: 11, expandedStates: 6, complete, exact: complete, stopReason: complete ? 'exact-solved' : 'state-budget' } };
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ai-v2-combined.js'), 'utf8'), sandbox, { filename: 'ai-v2-combined.js' });
  return { ai: sandbox.LudoV2Combined, calls };
}

test('默认配置冻结且明确导出版本与浏览器全局接口', () => {
  assert.equal(Object.isFrozen(Combined.DEFAULT_CONFIG), true);
  assert.deepEqual(Combined.DEFAULT_CONFIG, { searchProfile: 'completion', budgetMs: 600, maxNodes: 60000, maxDepth: 64, maxCacheEntries: 20000, endgameBudgetMs: 120, maxEndgameStates: 24000 });
  assert.equal(typeof Combined.STRATEGY_VERSION, 'string'); assert.equal(typeof Combined.EVALUATION_VERSION, 'string');
  assert.equal(typeof harness().ai.chooseAction, 'function');
});

test('非残局只运行一次所选搜索，没有重复中级备用或残局试算', () => {
  for (const searchProfile of ['completion', 'hybrid', 'classic']) {
    const mock = harness();
    const result = mock.ai.chooseAction(position(), undefined, { searchProfile });
    assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].name, searchProfile);
    if (searchProfile === 'classic') assert.equal(mock.calls[0].level, 'ultimate');
    assert.equal(result.diagnostics.endgame.attempted, false); assert.equal(result.diagnostics.endgame.elapsedMs, 0);
    assert.equal(result.diagnostics.exact, false); assert.equal(result.probability, null);
    assert.equal(result.diagnostics.difficulty, 'ultimate');
    assert.equal(mock.calls[0].options.budgetMs, 600);
  }
});

test('完整精确残局结果直接采用，概率和诊断保留且不再启动常规搜索', () => {
  const mock = harness({ exact: true, endgameMs: 30 });
  const result = mock.ai.chooseAction(position(true));
  assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].name, 'endgame');
  assert.equal(mock.calls[0].options.budgetMs, 120); assert.equal(mock.calls[0].options.maxStates, 24000);
  assert.equal(result.probability, 0.7); assert.equal(result.diagnostics.exact, true);
  assert.equal(result.diagnostics.difficulty, 'ultimate');
  assert.equal(result.diagnostics.endgame.elapsedMs, 30); assert.equal(result.diagnostics.elapsedMs, 30);
  assert.equal(result.diagnostics.search.attempted, false); assert.equal(result.diagnostics.visitedNodes, 11);
});

test('残局未完成后只将总预算剩余部分交给搜索，两个阶段用时分别记录', () => {
  const mock = harness({ endgameMs: 95, searchMs: 70 });
  const result = mock.ai.chooseAction(position(true), undefined, { budgetMs: 600, endgameBudgetMs: 120 });
  assert.equal(mock.calls.length, 2); assert.equal(mock.calls[0].options.budgetMs, 120);
  assert.equal(mock.calls[1].options.budgetMs, 505);
  assert.equal(result.diagnostics.endgame.complete, false); assert.equal(result.diagnostics.endgame.elapsedMs, 95);
  assert.equal(result.diagnostics.search.budgetMs, 505); assert.equal(result.diagnostics.search.elapsedMs, 70);
  assert.equal(result.diagnostics.elapsedMs, 165); assert.equal(result.diagnostics.budgetMs, 600);
  assert.equal(result.diagnostics.visitedNodes, 18); assert.equal(result.diagnostics.completedDepth, 2);
  assert.equal(result.probability, null);
});

test('残局试算额度受总预算限制，耗尽后只返回合法静态备用', () => {
  const mock = harness({ endgameMs: 50, staticMs: 2 });
  const waiting = position(true), result = mock.ai.chooseAction(waiting, undefined, { budgetMs: 40 });
  assert.equal(mock.calls[0].options.budgetMs, 40);
  assert.equal(mock.calls[1].name, 'classic'); assert.equal(mock.calls[1].level, 'medium');
  assert.equal(result.diagnostics.search.budgetMs, 0); assert.equal(result.diagnostics.search.mode, 'static-fallback');
  assert.equal(result.diagnostics.stopReason, 'total-budget-exhausted');
  assert.ok(E.getLegalActions(waiting).includes(result.action));
});

test('节点实验移除两段墙钟保护，残局状态额度和搜索操作额度仍保留', () => {
  const mock = harness();
  const result = mock.ai.chooseAction(position(true), undefined, { budgetMs: Infinity, maxEndgameStates: 60, maxNodes: 1000 });
  assert.equal(mock.calls[0].options.budgetMs, Infinity); assert.equal(mock.calls[0].options.maxStates, 60);
  assert.equal(mock.calls[1].options.budgetMs, Infinity); assert.equal(mock.calls[1].options.maxNodes, 1000);
  assert.equal(result.diagnostics.budgetMs, Infinity);
});

test('零预算立即给出合法静态备用，不消耗残局或搜索额度', () => {
  const mock = harness(), result = mock.ai.chooseAction(position(true), undefined, { budgetMs: 0 });
  assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].name, 'classic'); assert.equal(mock.calls[0].level, 'medium');
  assert.equal(result.diagnostics.difficulty, 'ultimate');
  assert.equal(result.diagnostics.endgame.attempted, false); assert.equal(result.diagnostics.exact, false);
  const actual = Combined.chooseAction(position(true), undefined, { budgetMs: 0 });
  assert.ok(E.getLegalActions(position(true)).includes(actual.action));
});

test('可以显式禁用残局，在非决策阶段不尝试任何树搜索', () => {
  for (const override of [{ endgameBudgetMs: 0 }, { maxEndgameStates: 0 }]) {
    const mock = harness(), result = mock.ai.chooseAction(position(true), undefined, override);
    assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].name, 'completion');
    assert.equal(result.diagnostics.endgame.stopReason, 'disabled');
  }
  const actual = Combined.chooseAction(E.createGame());
  assert.equal(actual.action, null); assert.equal(actual.diagnostics.stopReason, 'no-root-action');
});

test('真实三个搜索配置在非残局保持对应单独实现的动作和评分', () => {
  const state = position();
  const options = { budgetMs: Infinity, maxNodes: 600, maxDepth: 3, maxCacheEntries: 100 };
  for (const searchProfile of ['completion', 'hybrid', 'classic']) {
    const combined = Combined.chooseAction(state, undefined, { ...options, searchProfile });
    const base = searchProfile === 'classic' ? Classic.chooseAction(state, 'ultimate', undefined, options) : (searchProfile === 'completion' ? Completion : Hybrid).chooseAction(state, undefined, options);
    assert.equal(combined.action, base.action); assert.equal(combined.score, base.score);
    assert.equal(combined.diagnostics.search.visitedNodes, base.diagnostics.visitedNodes);
    assert.equal(combined.diagnostics.search.completedDepth, base.diagnostics.completedDepth);
  }
});

test('真实残局完整求解，输入不变且不消费 RNG，低状态额度可回退搜索', () => {
  const state = position(true), saved = JSON.stringify(state);
  const rng = () => { throw new Error('Deterministic combined policy must not consume RNG.'); };
  const exact = Combined.chooseAction(state, rng, { budgetMs: Infinity });
  assert.equal(exact.diagnostics.exact, true); assert.ok(exact.probability >= 0 && exact.probability <= 1);
  assert.equal(exact.diagnostics.search.attempted, false);
  const limited = Combined.chooseAction(state, rng, { budgetMs: Infinity, maxEndgameStates: 6, maxNodes: 200 });
  assert.equal(limited.diagnostics.endgame.complete, false); assert.equal(limited.diagnostics.endgame.stopReason, 'state-budget');
  assert.equal(limited.diagnostics.search.attempted, true); assert.equal(limited.diagnostics.exact, false);
  assert.equal(JSON.stringify(state), saved);
});

test('执行前验证输入和全部选项，拒绝无界残局状态数与拼写错误', () => {
  const before = position();
  for (const options of [{ searchProfile: 'unknown' }, { budgetMs: -1 }, { maxNodes: -1 }, { maxDepth: 0.5 }, { maxCacheEntries: Infinity }, { maxEndgameStates: Infinity }, { endgameBudgetMs: NaN }, { typo: 1 }]) {
    assert.throws(() => Combined.chooseAction(before, undefined, options));
  }
  assert.throws(() => Combined.chooseAction(before, 1), /rng/);
  assert.throws(() => Combined.chooseAction({}), /LudoEngine/);
  assert.throws(() => Combined.chooseAction(before, undefined, []), /options/);
});
