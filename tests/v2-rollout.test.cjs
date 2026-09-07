'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
const V = require('../src/ai-v2-eval.js');
const R = require('../src/ai-v2-rollout.js');

function fixture(own = [0, 12, 27, -1], enemy = [4, 18, 45, -1], die = 6) {
  return { ...E.createGame(0), tokenProgress: [own.slice(), enemy.slice()], phase: 'awaitingMove',
    pendingDie: die, consecutiveSixes: die === 6 ? 1 : 0 };
}
function options(overrides = {}) {
  return { budgetMs: Infinity, maxNodes: Infinity, maxRounds: 4, maxRolloutSteps: 24, ...overrides };
}
function choose(state, overrides = {}, seed = 'paired-rollout-test') {
  return R.chooseAction(state, AI.createSeededRng(seed), options(overrides));
}
function freeze(value) {
  Object.freeze(value);
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item);
  return value;
}

test('续玩候选公开冻结配置，预算和随机数输入验证', () => {
  assert.ok(Object.isFrozen(R.CONFIG));
  assert.equal(R.CONFIG.budgetMs, 600);
  for (const name of Object.keys(R.CONFIG)) {
    for (const invalid of [-1, NaN, null, '4']) {
      assert.throws(() => choose(fixture(), { [name]: invalid }), RangeError, name);
    }
  }
  for (const name of ['maxRounds', 'maxRolloutSteps', 'priorWeight']) {
    assert.throws(() => choose(fixture(), { [name]: Infinity }), RangeError);
  }
  for (const name of ['maxNodes', 'maxRounds', 'maxRolloutSteps']) {
    assert.throws(() => choose(fixture(), { [name]: 0.5 }), RangeError);
  }
  for (const invalid of [null, [], 1]) assert.throws(() => R.chooseAction(fixture(), Math.random, invalid), TypeError);
  assert.throws(() => R.chooseAction(fixture(), null), TypeError);
  for (const invalid of [-0.1, 1, NaN, Infinity, '0']) {
    assert.throws(() => R.chooseAction(fixture(), () => invalid, options()), RangeError);
  }
});

test('零时间和零节点都返回完整合法静态备用，不消耗策略随机数', () => {
  const state = fixture();
  const expected = E.getLegalActions(state).map(action => ({ action,
    score: V.fastValue(E.applyAction(state, action), state.activePlayer) }))
    .sort((a, b) => b.score - a.score || a.action - b.action)[0];
  for (const limits of [{ budgetMs: 0 }, { maxNodes: 0 }, { maxRounds: 0 }]) {
    const result = R.chooseAction(state, () => { throw new Error('不应取随机数'); }, options(limits));
    assert.equal(result.action, expected.action);
    assert.equal(result.score, expected.score);
    assert.equal(result.diagnostics.completedRounds, 0);
    assert.equal(result.diagnostics.visitedNodes, 0);
    assert.ok(result.diagnostics.rootScores.every(root => root.samples === 0));
  }
});

test('不同棋子产生相同后继时合并，强制走法无需模拟', () => {
  let calls = 0;
  const result = R.chooseAction(fixture([-1, -1, -1, -1]), () => { calls++; return 0.5; }, options());
  assert.equal(result.action, 0);
  assert.equal(result.diagnostics.legalActions, 4);
  assert.equal(result.diagnostics.uniqueSuccessors, 1);
  assert.equal(result.diagnostics.stopReason, 'only-distinct-successor');
  assert.equal(result.diagnostics.visitedNodes, 0);
  assert.equal(calls, 0);
});

test('立即获胜优先于所有预算，真实结束及等待掷骰状态没有动作', () => {
  const state = fixture([56, 56, 55, 56], [0, 12, 27, -1], 1);
  const result = choose(state, { budgetMs: 0, maxNodes: 0 });
  assert.equal(result.action, 2);
  assert.equal(result.score, 1);
  assert.equal(result.diagnostics.stopReason, 'immediate-win');
  for (const noMove of [E.applyAction(state, 2), E.createGame()]) {
    const noAction = choose(noMove);
    assert.equal(noAction.action, null);
    assert.equal(noAction.diagnostics.stopReason, 'no-legal-actions');
  }
});

test('确定节点条件下同策略种子得到完全相同结果，且不改冻结输入', () => {
  const state = freeze(fixture());
  const before = JSON.stringify(state);
  const a = choose(state), b = choose(state);
  delete a.diagnostics.elapsedMs;
  delete b.diagnostics.elapsedMs;
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(state), before);
  assert.equal(a.diagnostics.completedRounds, 4);
  assert.ok(a.diagnostics.rootScores.every(root => root.samples === 4));
});

test('每完成一轮仅从外部策略随机流取一个种子，所有根候选共同配对', () => {
  let calls = 0;
  const result = R.chooseAction(fixture(), () => { calls++; return 0.375; }, options({ maxRounds: 3 }));
  assert.equal(calls, 3);
  assert.equal(result.diagnostics.completedRounds, 3);
  for (const root of result.diagnostics.rootScores) {
    assert.equal(root.samples, 3);
    assert.equal(root.wins + root.losses + root.truncations, 3);
  }
});

test('第一轮只算到半途时不能提交分数或终局统计', () => {
  const baseline = choose(fixture(), { maxRounds: 0 });
  const interrupted = choose(fixture(), { maxNodes: 1 });
  assert.equal(interrupted.diagnostics.visitedNodes, 1);
  assert.equal(interrupted.diagnostics.completedRounds, 0);
  assert.equal(interrupted.diagnostics.stopReason, 'node-budget');
  assert.deepEqual(interrupted.diagnostics.rootScores, baseline.diagnostics.rootScores);
  assert.equal(interrupted.action, baseline.action);
  assert.equal(interrupted.score, baseline.score);
  assert.equal(interrupted.diagnostics.terminalRollouts + interrupted.diagnostics.truncatedRollouts, 0);
});

test('完成一轮之后中断下一轮，保留上一完整轮的选择及统计', () => {
  const state = fixture();
  const oneRound = choose(state, { maxRounds: 1 });
  const partial = choose(state, { maxRounds: 2, maxNodes: oneRound.diagnostics.visitedNodes + 1 });
  assert.equal(partial.diagnostics.completedRounds, 1);
  assert.equal(partial.diagnostics.stopReason, 'node-budget');
  assert.equal(partial.action, oneRound.action);
  assert.equal(partial.score, oneRound.score);
  assert.deepEqual(partial.diagnostics.rootScores, oneRound.diagnostics.rootScores);
  assert.equal(partial.diagnostics.terminalRollouts, oneRound.diagnostics.terminalRollouts);
  assert.equal(partial.diagnostics.truncatedRollouts, oneRound.diagnostics.truncatedRollouts);
});

test('所有候选相同的模拟骰序在对称棋子选择下给出相同样本', () => {
  // 交换两个可移动棋子的编号，物理局面不变，动作也应随编号交换。
  const state = fixture([0, 12, 27, -1]);
  const swapped = fixture([27, 12, 0, -1]);
  const original = choose(state, { maxRounds: 5 });
  const changed = choose(swapped, { maxRounds: 5 });
  const mapping = [2, 1, 0, 3];
  for (const first of original.diagnostics.rootScores) {
    const second = changed.diagnostics.rootScores.find(root => root.action === mapping[first.action]);
    assert.ok(Math.abs(first.score - second.score) < 1e-12);
    assert.equal(first.wins, second.wins);
    assert.equal(first.losses, second.losses);
    assert.equal(first.truncations, second.truncations);
  }
});

test('截断模拟只记估计价值，不能冒充真实胜负', () => {
  const result = choose(fixture(), { maxRounds: 3, maxRolloutSteps: 0, priorWeight: 0 });
  assert.equal(result.diagnostics.terminalRollouts, 0);
  assert.equal(result.diagnostics.truncatedRollouts, result.diagnostics.uniqueSuccessors * 3);
  assert.equal(result.diagnostics.scoreKind, 'estimated-value');
  for (const root of result.diagnostics.rootScores) {
    assert.equal(root.wins + root.losses, 0);
    assert.ok(Math.abs(root.score - root.staticValue) < 1e-12);
    assert.equal(root.truncations, 3);
  }
});

test('残局续玩到真实终局后，样本均值与真实胜负计数吻合', () => {
  const state = fixture([54, 55, 56, 56], [54, 55, 56, 56], 1);
  const result = choose(state, { maxRounds: 12, maxRolloutSteps: 1000, priorWeight: 0 });
  assert.equal(result.diagnostics.truncatedRollouts, 0);
  assert.equal(result.diagnostics.terminalRollouts, 24);
  for (const root of result.diagnostics.rootScores) {
    assert.equal(root.samples, 12);
    assert.equal(root.wins + root.losses, 12);
    assert.equal(root.score, (root.wins - root.losses) / 12);
  }
});

test('多局模拟只选引擎认可的合法棋子，处理连续六点和无法移动', () => {
  for (let game = 0; game < 4; game++) {
    const judge = AI.createSeededRng('rollout-legality-judge-' + game);
    const strategy = AI.createSeededRng('rollout-legality-strategy-' + game);
    let state = E.createGame(game % 2);
    let rolls = 0;
    while (state.phase !== 'finished' && rolls < 2000) {
      if (state.phase === 'awaitingRoll') {
        state = E.applyRoll(state, 1 + Math.floor(judge() * 6));
        rolls++;
      } else {
        const result = R.chooseAction(state, strategy, options({ maxRounds: 1, maxRolloutSteps: 12 }));
        assert.ok(E.getLegalActions(state).includes(result.action));
        assert.ok(result.score === null || (Number.isFinite(result.score) && Math.abs(result.score) <= 1));
        state = E.applyAction(state, result.action);
      }
    }
    assert.equal(state.phase, 'finished', 'game ' + game + ' must finish');
  }
});
