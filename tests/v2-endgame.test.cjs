'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const S = require('../src/ai-v2-endgame.js');

function state(left, right, player = 0, streak = 0) {
  const result = E.createGame(player);
  result.tokenProgress = [left, right].map(tokens => tokens.concat(Array(4 - tokens.length).fill(56)));
  result.consecutiveSixes = streak;
  E.validateState(result);
  return result;
}
function close(actual, expected, tolerance = 1e-10) { assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' versus ' + expected); }
const UNLIMITED_TIME = { budgetMs: Infinity, maxStates: 100000 };

// 独立参考：显式枚举完整状态图并迭代 Bellman 方程，不使用生产版的六状态消元或距离递归。
function valueIteration(root, perspective) {
  const nodes = new Map(), pending = [root];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor], key = E.stateKey(current, { canonicalTokens: true });
    if (nodes.has(key)) continue;
    let children = [];
    if (current.phase === 'awaitingRoll') children = Array.from({ length: 6 }, (_, index) => E.applyRoll(current, index + 1));
    else if (current.phase === 'awaitingMove') children = E.getLegalActions(current).map(action => E.applyAction(current, action));
    nodes.set(key, { state: current, children: children.map(child => E.stateKey(child, { canonicalTokens: true })) });
    pending.push(...children);
  }
  let values = new Map([...nodes].map(([key, node]) => [key, node.state.phase === 'finished' ? Number(node.state.winner === perspective) : 0.5]));
  let residual = Infinity, iterations = 0;
  for (; iterations < 10000 && residual > 1e-13; iterations += 1) {
    const next = new Map(); residual = 0;
    for (const [key, node] of nodes) {
      const current = node.state;
      let value;
      if (current.phase === 'finished') value = Number(current.winner === perspective);
      else if (current.phase === 'awaitingRoll') value = node.children.reduce((sum, child) => sum + values.get(child), 0) / 6;
      else value = current.activePlayer === perspective ? Math.max(...node.children.map(child => values.get(child))) : Math.min(...node.children.map(child => values.get(child)));
      residual = Math.max(residual, Math.abs(value - values.get(key))); next.set(key, value);
    }
    values = next;
  }
  assert.ok(residual <= 1e-13, 'Independent value iteration did not converge.');
  return { values, nodes, residual, iterations, value: values.get(E.stateKey(root, { canonicalTokens: true })) };
}

test('只接受双方所有未完成棋子均在专属通道的残局，普通棋局返回 null', () => {
  assert.equal(S.canSolve(E.createGame()), false);
  assert.equal(S.chooseAction(E.createGame()), null);
  assert.equal(S.canSolve(state([51], [55])), true);
  assert.equal(S.canSolve(state([50], [55])), false);
  assert.equal(S.analyze(state([51], [55])).diagnostics.stopReason, 'no-root-action');
  const waiting = E.applyRoll(state([50], [55]), 1);
  assert.equal(S.chooseAction(waiting), null);
});

test('两方都差一格时，三连 6 规则给出先手胜率 216/389', () => {
  const before = state([55], [55]);
  const result = S.solveState(before, 0, UNLIMITED_TIME);
  assert.equal(result.complete, true); close(result.probability, 216 / 389);
  // 一回合的三个成功机会：1/6、先掷 6 再掷 1、连续两个 6 再掷 1。
  const turnWin = 1 / 6 + 1 / 36 + 1 / 216;
  close(result.probability, 1 / (2 - turnWin));
  assert.ok(Math.abs(result.probability - 6 / 11) > 0.005);
  for (let streak = 0; streak < 3; streak += 1) {
    const sameTurnWin = [43 / 216, 7 / 36, 1 / 6][streak];
    close(S.solveState(state([55], [55], 0, streak), 0, UNLIMITED_TIME).probability, sameTurnWin + (1 - sameTurnWin) * (1 - 216 / 389));
    close(S.solveState(state([55], [55], 1, streak), 0, UNLIMITED_TIME).probability, 1 - (sameTurnWin + (1 - sameTurnWin) * (1 - 216 / 389)));
  }
});

test('已结束状态为真实 0/1 概率，当前直接到家走法为 1', () => {
  const waiting = E.applyRoll(state([55], [54]), 1);
  const result = S.chooseAction(waiting, () => { throw new Error('Exact solver must not consume RNG.'); }, UNLIMITED_TIME);
  assert.equal(result.action, 0); assert.equal(result.score, 1); assert.equal(result.probability, 1);
  const terminal = E.applyAction(waiting, result.action);
  assert.equal(S.solveState(terminal, 0, UNLIMITED_TIME).probability, 1);
  assert.equal(S.solveState(terminal, 1, UNLIMITED_TIME).probability, 0);
});

test('非最后一子到家后的再掷奖励计入精确概率，而非交给对手', () => {
  const waiting = E.applyRoll(state([55, 55], [55]), 1);
  const result = S.analyze(waiting, UNLIMITED_TIME);
  assert.equal(result.complete, true);
  // 先送回一子后仍由自己掷骰，剩余双方各差一格，等于已独立推导的先手概率。
  close(result.probability, 216 / 389);
  assert.equal(E.applyAction(waiting, result.action).activePlayer, 0);
});

test('独立全图值迭代核对不对称残局、连续 6 与多子选择', () => {
  const cases = [state([54], [55]), state([53], [54], 1, 2), state([54, 55], [54, 55]), state([53, 55], [54, 55], 1, 1)];
  for (const before of cases) {
    const reference = valueIteration(before, 0), actual = S.solveState(before, 0, UNLIMITED_TIME);
    assert.equal(actual.complete, true); close(actual.probability, reference.value);
    assert.ok(actual.diagnostics.maxEquationResidual < 1e-12);
    // 同一独立状态图中的各等待掷骰状态，逐个检查生产解与参考解一致。
    for (const [key, node] of [...reference.nodes].filter(([, node]) => node.state.phase === 'awaitingRoll').slice(0, 18)) {
      const solved = S.solveState(node.state, 0, UNLIMITED_TIME);
      close(solved.probability, reference.values.get(key));
    }
  }
});

test('根节点所有候选都与独立参考值一致，按真实胜率选择最优动作', () => {
  const waiting = E.applyRoll(state([53, 55], [54, 55]), 1);
  const reference = valueIteration(waiting, waiting.activePlayer);
  const result = S.chooseAction(waiting, undefined, UNLIMITED_TIME);
  assert.equal(result.complete, true); assert.equal(result.diagnostics.exact, true);
  close(result.probability, reference.value);
  for (const candidate of result.diagnostics.rootProbabilities) {
    const child = E.applyAction(waiting, candidate.action);
    close(candidate.probability, reference.values.get(E.stateKey(child, { canonicalTokens: true })));
  }
  assert.ok(E.getLegalActions(waiting).includes(result.action));
});

test('阵营和视角互换概率互补，棋子编号置换保持价值和等价最佳后继', () => {
  const before = state([52, 55], [54, 55], 1, 2);
  close(S.solveState(before, 0, UNLIMITED_TIME).probability + S.solveState(before, 1, UNLIMITED_TIME).probability, 1);
  const swapped = state(before.tokenProgress[1], before.tokenProgress[0], 0, 2);
  close(S.solveState(before, 0, UNLIMITED_TIME).probability, S.solveState(swapped, 1, UNLIMITED_TIME).probability);
  const a = E.applyRoll(state([53, 55], [54, 55]), 1);
  const b = E.cloneState(a); b.tokenProgress[0].reverse(); b.tokenProgress[1].reverse();
  const chosenA = S.chooseAction(a, undefined, UNLIMITED_TIME), chosenB = S.chooseAction(b, undefined, UNLIMITED_TIME);
  close(chosenA.probability, chosenB.probability);
  assert.equal(E.stateKey(E.applyAction(a, chosenA.action), { canonicalTokens: true }), E.stateKey(E.applyAction(b, chosenB.action), { canonicalTokens: true }));
});

test('输入只读且不消耗 RNG，缓存仅本次请求所有且受 maxStates 限制', () => {
  const waiting = E.applyRoll(state([53, 55], [54, 55]), 1), saved = JSON.stringify(waiting);
  waiting.tokenProgress.forEach(Object.freeze); Object.freeze(waiting.tokenProgress); Object.freeze(waiting);
  const random = () => { throw new Error('Unexpected RNG use.'); };
  const first = S.chooseAction(waiting, random, UNLIMITED_TIME), second = S.chooseAction(waiting, random, UNLIMITED_TIME);
  assert.equal(JSON.stringify(waiting), saved);
  close(first.probability, second.probability);
  assert.equal(first.diagnostics.expandedStates, second.diagnostics.expandedStates);
  assert.equal(first.diagnostics.cacheHits, second.diagnostics.cacheHits);
  assert.ok(first.diagnostics.solvedStates <= first.diagnostics.expandedStates);
  assert.equal(first.diagnostics.cachedBoards * 6, first.diagnostics.solvedStates);
});

test('预算中断无伪精确值和部分根选招，允许调用方交回常规策略', () => {
  const before = state([51, 52, 53, 54], [51, 52, 53, 54]);
  const small = S.solveState(before, 0, { budgetMs: Infinity, maxStates: 6 });
  assert.equal(small.complete, false); assert.equal(small.probability, null); assert.equal(small.diagnostics.exact, false);
  assert.equal(small.diagnostics.stopReason, 'state-budget'); assert.ok(small.diagnostics.expandedStates <= 6);
  const waiting = E.applyRoll(before, 1), zero = S.analyze(waiting, { budgetMs: 0, maxStates: 24000 });
  assert.equal(zero.complete, false); assert.equal(zero.action, null); assert.equal(zero.score, null); assert.equal(zero.probability, null);
  assert.equal(zero.diagnostics.stopReason, 'time-budget'); assert.equal(Object.hasOwn(zero.diagnostics, 'rootProbabilities'), false);
  assert.equal(S.chooseAction(waiting, undefined, { budgetMs: Infinity, maxStates: 0 }), null);
});

test('非法预算或不正确的入口阶段明确报错', () => {
  const before = state([55], [54]);
  assert.throws(() => S.solveState(before, 2), /Perspective/);
  assert.throws(() => S.solveState(before, 0, { maxStates: Infinity }), /maxStates/);
  assert.throws(() => S.solveState(before, 0, { budgetMs: -1 }), /budgetMs/);
  assert.throws(() => S.solveState(E.applyRoll(before, 1), 0), /use analyze/);
});
