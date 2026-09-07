'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
const Old = require('./fixtures/ai-v1/ai.js');
const Eval = require('../src/ai-v2-eval.js');
const Search = require('../src/ai-v2-search.js');
const make = (active = 0) => ({ ...E.createGame(active), tokenProgress: [[0, 12, 27, -1], [4, 18, 45, -1]], phase: 'awaitingMove', pendingDie: 6, consecutiveSixes: 1 });

test('评分注入后初中高级仍与冻结旧版产生相同走法和分数', () => {
  const dice = Old.createSeededRng('legacy-regression');
  let state = E.createGame(0), positions = 0;
  for (let step = 0; step < 140 && state.phase !== 'finished'; step++) {
    if (state.phase === 'awaitingRoll') state = E.applyRoll(state, 1 + Math.floor(dice() * 6));
    if (state.phase !== 'awaitingMove') continue;
    for (const level of ['beginner', 'medium', 'advanced']) {
      const options = { budgetMs: Infinity };
      const before = Old.chooseAction(state, level, Old.createSeededRng(step), options);
      const after = AI.chooseAction(state, level, AI.createSeededRng(step), options);
      assert.equal(after.action, before.action); assert.equal(after.score, before.score);
      assert.equal(after.diagnostics.completedDepth, before.diagnostics.completedDepth);
    }
    positions++;
    state = E.applyAction(state, Old.chooseAction(state, 'medium').action);
  }
  assert.ok(positions > 30);
});

test('V2搜索逐骰枚举结果与独立一层穷举一致', () => {
  const state = make();
  const result = Search.chooseAction(state, undefined, { budgetMs: Infinity, maxNodes: Infinity, maxDepth: 1 });
  for (const entry of result.diagnostics.rootScores) {
    const after = E.applyAction(state, entry.action);
    let expected = 0;
    for (let die = 1; die <= 6; die++) {
      const rolled = E.applyRoll(after, die);
      if (rolled.phase !== 'awaitingMove') expected += Eval.fastValue(rolled, state.activePlayer) / 6;
      else {
        const values = E.getLegalActions(rolled).map(action => Eval.fastValue(E.applyAction(rolled, action), state.activePlayer));
        expected += (rolled.activePlayer === state.activePlayer ? Math.max(...values) : Math.min(...values)) / 6;
      }
    }
    assert.ok(Math.abs(entry.score - expected) < 1e-11);
  }
});

test('V2零预算回退到同一V2静态评价，输入和策略随机数不变', () => {
  const state = make(), before = structuredClone(state);
  const result = Search.chooseAction(state, () => { throw new Error('Search consumed RNG'); }, { maxNodes: 0 });
  const values = E.getLegalActions(state).map(action => ({ action, value: Eval.fastValue(E.applyAction(state, action), state.activePlayer) })).sort((a, b) => b.value - a.value || a.action - b.action);
  assert.equal(result.action, values[0].action);
  assert.equal(result.diagnostics.completedDepth, 0);
  assert.deepEqual(state, before);
  assert.throws(() => Search.chooseAction(state, undefined, { profile: 'unknown' }));
});
