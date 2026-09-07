'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const AI = require('../src/ai.js');

function fixture(own, enemy, die = 3, player = 0, sixes = die === 6 ? 1 : 0) {
  return { ...E.createGame(player), tokenProgress: [own.slice(), enemy.slice()],
    phase: 'awaitingMove', pendingDie: die, consecutiveSixes: sixes };
}
const middle = () => fixture([0, 12, 27, -1], [4, 18, 45, -1], 6);
const unbounded = depth => ({ budgetMs: Infinity, maxNodes: Infinity, maxDepth: depth });
function close(actual, expected, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-11, `${label}: ${actual} != ${expected}`);
}

// 独立基准沿用第一阶段的引擎投影枚举，不调用优化评价、候选去重或搜索内部函数。
function referencePosition(progress) {
  if (progress === -1) return -0.15;
  if (progress <= 50) return 0.60 * Math.pow(progress / 50, 1.25);
  if (progress <= 55) return 0.70 + 0.04 * (progress - 51);
  return 1;
}
function referenceEvaluation(state, perspective) {
  if (state.winner !== null) return { value: state.winner === perspective ? 1 : -1 };
  const position = state.tokenProgress.map(side => side.reduce((sum, p) => sum + referencePosition(p), 0));
  const mobility = [], noActionProbability = [], threatLoss = [], captureOpportunity = [];
  for (const player of [0, 1]) {
    const projection = { ...E.cloneState(state), activePlayer: player, phase: 'awaitingRoll',
      pendingDie: null, consecutiveSixes: 0 };
    let successors = 0, noAction = 0, lossSum = 0, captureDice = 0;
    for (let die = 1; die <= 6; die++) {
      const rolled = E.applyRoll(projection, die);
      const seen = new Set();
      let worstLoss = 0;
      const actions = E.getLegalActions(rolled);
      if (!actions.length) noAction++;
      for (const action of actions) {
        const after = E.applyAction(rolled, action);
        const key = E.stateKey(after, { canonicalTokens: true });
        seen.add(key);
        let loss = 0;
        for (let token = 0; token < 4; token++) {
          const beforeProgress = state.tokenProgress[1 - player][token];
          if (beforeProgress >= 0 && beforeProgress < 56 && after.tokenProgress[1 - player][token] === -1) {
            loss += referencePosition(beforeProgress) - referencePosition(-1);
          }
        }
        worstLoss = Math.max(worstLoss, loss);
      }
      successors += seen.size;
      lossSum += worstLoss;
      if (worstLoss > 0) captureDice++;
    }
    mobility[player] = successors / 24;
    noActionProbability[player] = noAction / 6;
    threatLoss[1 - player] = lossSum / 6;
    captureOpportunity[1 - player] = captureDice / 6;
  }
  const opponent = 1 - perspective;
  const z = position[perspective] - position[opponent] +
    0.15 * (mobility[perspective] - mobility[opponent]) -
    0.50 * (threatLoss[perspective] - threatLoss[opponent]);
  return { value: 0.95 * Math.tanh(z / 2), position, mobility, noActionProbability, threatLoss, captureOpportunity };
}

// 朴素递归不缓存、不排序、不去重，枚举每个合法棋子与全部六个等概率骰点。
function referenceBeforeRoll(state, depth, perspective) {
  if (state.winner !== null || depth === 0) return referenceEvaluation(state, perspective).value;
  const outcomes = [];
  for (let die = 1; die <= 6; die++) {
    const rolled = E.applyRoll(state, die);
    if (rolled.phase !== 'awaitingMove') {
      outcomes.push(referenceBeforeRoll(rolled, depth - 1, perspective));
    } else {
      const values = E.getLegalActions(rolled).map(action =>
        referenceBeforeRoll(E.applyAction(rolled, action), depth - 1, perspective));
      outcomes.push(rolled.activePlayer === perspective ? Math.max(...values) : Math.min(...values));
    }
  }
  return outcomes.reduce((sum, value) => sum + value / 6, 0);
}
function referenceRoot(state, depth) {
  return E.getLegalActions(state).map(action => ({ action,
    score: referenceBeforeRoll(E.applyAction(state, action), depth, state.activePlayer)
  })).sort((a, b) => b.score - a.score || a.action - b.action);
}

test('快速叶评价在 250 个布局上与独立引擎投影的数值及特征相同', () => {
  const rng = AI.createSeededRng('fast-evaluation-reference-v1');
  for (let sample = 0; sample < 250; sample++) {
    const state = { ...E.createGame(sample % 2), tokenProgress: Array.from({ length: 2 }, () =>
      Array.from({ length: 4 }, () => Math.floor(rng() * 58) - 1)) };
    E.validateState(state);
    for (const perspective of [0, 1]) {
      const actual = AI.evaluate(state, perspective);
      const reference = referenceEvaluation(state, perspective);
      close(actual.value, reference.value);
      for (const name of ['position', 'mobility', 'noActionProbability', 'threatLoss', 'captureOpportunity']) {
        assert.deepEqual(actual.features[name], reference[name], `${sample}: ${name}`);
      }
    }
  }
});

const cases = [
  ['普通换人并枚举对手最小价值', fixture([12, 4, -1, -1], [42, 20, -1, -1], 4), 2],
  ['第一次六后仍按同一玩家最大价值', fixture([10, -1, -1, -1], [35, 52, -1, -1], 6), 2],
  ['第二次六后下一六直接换人', fixture([10, -1, -1, -1], [35, 52, -1, -1], 6, 0, 2), 2],
  ['终点超点与六无合法动作仍消耗深度', fixture([53, 54, 56, 56], [55, 56, 56, 56], 1), 3],
  ['黄色活动方及普通格叠子被吃', fixture([10, 10, -1, -1], [35, 29, -1, -1], 1, 1), 2],
  ['归家通道无敌方攻击', fixture([51, 54, 56, 56], [50, 55, 56, 56], 1), 2]
];
for (const [description, state, depth] of cases) {
  test(`完整概率搜索参考对照：${description}`, () => {
    const actual = AI.chooseAction(state, 'advanced', null, unbounded(depth));
    const reference = referenceRoot(state, depth);
    assert.equal(actual.diagnostics.completedDepth, depth);
    assert.equal(actual.diagnostics.stopReason, 'max-depth');
    close(actual.score, reference[0].score);
    assert.equal(actual.action, reference[0].action);
    for (const root of actual.diagnostics.rootScores) {
      close(root.score, reference.find(entry => entry.action === root.action).score);
    }
  });
}

test('根骰点已知，零未来深度与原中级动作和分数一致', () => {
  const state = middle();
  const medium = AI.chooseAction(state, 'medium');
  for (const level of ['advanced', 'ultimate']) {
    const result = AI.chooseAction(state, level, null, unbounded(0));
    assert.equal(result.action, medium.action);
    assert.equal(result.score, medium.score);
    assert.equal(result.diagnostics.completedDepth, 0);
    assert.equal(result.diagnostics.visitedNodes, 0);
  }
});

test('中途耗尽节点额度只提交最后完整层的全部根分数', () => {
  const state = middle();
  const complete = AI.chooseAction(state, 'advanced', null, { ...unbounded(1), maxCacheEntries: 0 });
  const interrupted = AI.chooseAction(state, 'advanced', null, {
    ...unbounded(3), maxNodes: complete.diagnostics.visitedNodes + 40, maxCacheEntries: 0
  });
  assert.equal(interrupted.diagnostics.stopReason, 'node-budget');
  assert.equal(interrupted.diagnostics.attemptedDepth, 2);
  assert.equal(interrupted.diagnostics.completedDepth, 1);
  assert.equal(interrupted.action, complete.action);
  assert.equal(interrupted.score, complete.score);
  assert.deepEqual(interrupted.diagnostics.rootScores, complete.diagnostics.rootScores);
  assert.equal(interrupted.diagnostics.visitedNodes, complete.diagnostics.visitedNodes + 40);
});

test('零节点或零时间预算仍返回完整中级备用，不使用部分骰点平均值', () => {
  const state = middle();
  const medium = AI.chooseAction(state, 'medium');
  for (const options of [{ maxNodes: 0, budgetMs: Infinity }, { maxNodes: Infinity, budgetMs: 0 }]) {
    const result = AI.chooseAction(state, 'ultimate', null, options);
    assert.equal(result.action, medium.action);
    assert.equal(result.score, medium.score);
    assert.equal(result.diagnostics.completedDepth, 0);
    assert.equal(result.diagnostics.visitedNodes, 0);
    assert.equal(result.diagnostics.stopReason, options.maxNodes === 0 ? 'node-budget' : 'time-budget');
    assert.deepEqual(result.diagnostics.rootScores, AI.rankActions(state).map(({ action, score }) => ({ action, score })));
  }
});

test('有界缓存和无缓存得到相同的完整值，缓存确实命中且容量不超限', () => {
  const state = cases[3][1];
  const uncached = AI.chooseAction(state, 'ultimate', null, { ...unbounded(3), maxCacheEntries: 0 });
  for (const capacity of [1, 17, 20000]) {
    const cached = AI.chooseAction(state, 'ultimate', null, { ...unbounded(3), maxCacheEntries: capacity });
    assert.equal(cached.action, uncached.action);
    close(cached.score, uncached.score);
    assert.ok(cached.diagnostics.cacheEntries <= capacity);
    if (capacity === 20000) assert.ok(cached.diagnostics.cacheHits > 0);
  }
});

test('搜索不改变冻结状态、不调用策略 RNG，固定额度重复结果一致', () => {
  const state = middle();
  state.tokenProgress.forEach(Object.freeze);
  Object.freeze(state.tokenProgress);
  Object.freeze(state);
  const snapshot = JSON.stringify(state);
  const forbiddenRng = () => { throw new Error('搜索不得读取骰子或策略随机流'); };
  const options = { budgetMs: Infinity, maxNodes: 2500, maxDepth: 5 };
  const one = AI.chooseAction(state, 'ultimate', forbiddenRng, options);
  const two = AI.chooseAction(state, 'ultimate', forbiddenRng, options);
  const { elapsedMs: elapsedOne, ...diagnosticsOne } = one.diagnostics;
  const { elapsedMs: elapsedTwo, ...diagnosticsTwo } = two.diagnostics;
  assert.equal(one.action, two.action);
  assert.equal(one.score, two.score);
  assert.deepEqual(diagnosticsOne, diagnosticsTwo);
  assert.equal(JSON.stringify(state), snapshot);
});

test('交换阵营及活动方后搜索价值与等价选择保持对称', () => {
  const state = middle();
  const swapped = { ...state, activePlayer: 1,
    tokenProgress: [state.tokenProgress[1].slice(), state.tokenProgress[0].slice()] };
  const a = AI.chooseAction(state, 'advanced', null, unbounded(2));
  const b = AI.chooseAction(swapped, 'advanced', null, unbounded(2));
  close(a.score, b.score);
  assert.equal(a.action, b.action);
  close(AI.evaluate(E.applyAction(state, a.action), 0).value,
    -AI.evaluate(E.applyAction(swapped, b.action), 0).value);
});

test('棋子编号置换后的选招产生等价后继，等价出营保留最小编号', () => {
  const state = middle();
  const permuted = { ...state, tokenProgress: [state.tokenProgress[0].slice().reverse(), state.tokenProgress[1].slice().reverse()] };
  const a = AI.chooseAction(state, 'ultimate', null, unbounded(2));
  const b = AI.chooseAction(permuted, 'ultimate', null, unbounded(2));
  close(a.score, b.score);
  assert.equal(E.stateKey(E.applyAction(state, a.action), { canonicalTokens: true }),
    E.stateKey(E.applyAction(permuted, b.action), { canonicalTokens: true }));
  const opening = AI.chooseAction(E.applyRoll(E.createGame(), 6), 'ultimate');
  assert.equal(opening.action, 0);
  assert.equal(opening.diagnostics.visitedNodes, 0);
});

test('高阶策略在生成合法快照及立即获胜、无动作边界返回合法动作', () => {
  const rng = AI.createSeededRng('generated-search-legality-v1');
  let state = E.createGame();
  let decisions = 0;
  for (let roll = 0; roll < 180 && state.winner === null; roll++) {
    state = E.applyRoll(state, 1 + Math.floor(rng() * 6));
    if (state.phase !== 'awaitingMove') continue;
    const level = decisions % 2 ? 'advanced' : 'ultimate';
    const choice = AI.chooseAction(state, level, null, { budgetMs: Infinity, maxNodes: 750, maxDepth: 3 });
    assert.ok(E.getLegalActions(state).includes(choice.action));
    assert.ok(choice.diagnostics.visitedNodes <= 750);
    state = E.applyAction(state, choice.action);
    decisions++;
  }
  assert.ok(decisions > 30);
  for (const level of ['advanced', 'ultimate']) {
    const win = fixture([55, 56, 56, 56], [-1, -1, -1, -1], 1);
    assert.equal(AI.chooseAction(win, level).score, 1);
    assert.equal(AI.chooseAction(E.createGame(), level).action, null);
  }
});

test('两档冻结预算具有真实深度差别，不能只改显示名称', () => {
  assert.ok(Object.isFrozen(AI.LEVEL_CONFIGS));
  assert.ok(Object.isFrozen(AI.LEVEL_CONFIGS.advanced));
  assert.equal(AI.LEVEL_CONFIGS.advanced.budgetMs, 150);
  assert.equal(AI.LEVEL_CONFIGS.ultimate.budgetMs, 600);
  const advanced = AI.chooseAction(middle(), 'advanced', null, { budgetMs: Infinity });
  const ultimate = AI.chooseAction(middle(), 'ultimate', null, { budgetMs: Infinity });
  assert.ok(advanced.diagnostics.completedDepth > 0);
  assert.ok(ultimate.diagnostics.completedDepth > advanced.diagnostics.completedDepth);
  assert.ok(ultimate.diagnostics.visitedNodes > advanced.diagnostics.visitedNodes);
});

test('非法预算明确拒绝，Infinity 仅允许时间和节点额度', () => {
  for (const options of [{ budgetMs: -1 }, { maxNodes: 1.5 }, { maxDepth: Infinity },
    { maxCacheEntries: -1 }, { budgetMs: NaN }, null]) {
    assert.throws(() => AI.chooseAction(middle(), 'advanced', null, options));
  }
  assert.throws(() => AI.chooseAction(middle(), 'impossible'));
});
