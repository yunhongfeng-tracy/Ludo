'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const AI = require('../src/ai.js');

function fixture(red = [-1, -1, -1, -1], yellow = [-1, -1, -1, -1], options = {}) {
  return { ...E.createGame(0), tokenProgress: [red.slice(), yellow.slice()], ...options };
}
function rolled(red, yellow, die, player = 0) {
  return fixture(red, yellow, { activePlayer: player, phase: 'awaitingMove', pendingDie: die, consecutiveSixes: die === 6 ? 1 : 0 });
}
function close(actual, expected, description = '') {
  assert.ok(Math.abs(actual - expected) < 1e-11, `${description}: actual=${actual}, expected=${expected}`);
}

test('位置价值严格随路程提高，基地和终点有不同价值', () => {
  let previous = AI.positionValue(-1);
  for (let progress = 0; progress <= 56; progress += 1) {
    const value = AI.positionValue(progress);
    assert.ok(Number.isFinite(value));
    assert.ok(value > previous, `progress=${progress}`);
    previous = value;
  }
  close(AI.positionValue(56), 1);
});

test('评价对视角反号，交换阵营后反号，普通局面严格有界', () => {
  const state = fixture([5, 40, 51, -1], [7, 34, 55, 56]);
  const a = AI.evaluate(state, 0);
  const b = AI.evaluate(state, 1);
  close(a.value, -b.value);
  assert.ok(Math.abs(a.value) < 0.95);
  const swapped = fixture(state.tokenProgress[1], state.tokenProgress[0]);
  close(AI.evaluate(swapped, 0).value, -a.value);
});

test('棋子编号置换不改变评价和独立特征', () => {
  const a = fixture([4, 20, -1, 55], [2, 39, -1, 56]);
  const b = fixture([55, -1, 4, 20], [-1, 56, 39, 2]);
  assert.deepEqual(AI.evaluate(a, 0), AI.evaluate(b, 0));
});

test('真实终局价值为正负1，尚未获胜的优势不能冒充终局', () => {
  const state = E.applyAction(rolled([55, 56, 56, 56], undefined, 1), 0);
  assert.equal(AI.evaluate(state, 0).value, 1);
  assert.equal(AI.evaluate(state, 1).value, -1);
  assert.ok(AI.evaluate(fixture([55, 56, 56, 56]), 0).value < 0.95);
});

for (const distance of [1, 2, 3, 4, 5, 6]) {
  test(`单个敌子相距 ${distance} 格的下一假想掷骰机会均为1/6`, () => {
    const state = fixture([20, -1, -1, -1], [46 - distance, -1, -1, -1]);
    const features = AI.evaluate(state, 0).features;
    close(features.captureOpportunity[0], 1 / 6);
    close(features.threatLoss[0], (AI.positionValue(20) - AI.positionValue(-1)) / 6);
  });
}

test('两个不同威胁骰点取事件并集，不只取最近一子', () => {
  const features = AI.evaluate(fixture([10, -1, -1, -1], [35, 32, -1, -1]), 0).features;
  close(features.captureOpportunity[0], 2 / 6);
  close(features.threatLoss[0], 2 * (AI.positionValue(10) - AI.positionValue(-1)) / 6);
});

test('两枚敌子对应相同骰点，机会与损失不重复相加', () => {
  const one = AI.evaluate(fixture([10, -1, -1, -1], [35, -1, -1, -1]), 0).features;
  const two = AI.evaluate(fixture([10, -1, -1, -1], [35, 35, -1, -1]), 0).features;
  close(two.captureOpportunity[0], 1 / 6);
  close(two.threatLoss[0], one.threatLoss[0]);
});

test('同骰点可吃不同目标时只计最坏一次行动，不能同时吃两格', () => {
  const features = AI.evaluate(fixture([10, 20, -1, -1], [35, 45, -1, -1]), 0).features;
  close(features.captureOpportunity[0], 1 / 6);
  close(features.threatLoss[0], (AI.positionValue(20) - AI.positionValue(-1)) / 6);
});

test('普通格叠子被吃风险计入全部损失', () => {
  const features = AI.evaluate(fixture([10, 10, -1, -1], [35, -1, -1, -1]), 0).features;
  close(features.captureOpportunity[0], 1 / 6);
  close(features.threatLoss[0], 2 * (AI.positionValue(10) - AI.positionValue(-1)) / 6);
});

test('安全格与归家通道捕获威胁为零', () => {
  const safety = AI.evaluate(fixture([8, 8, -1, -1], [33, -1, -1, -1]), 0).features;
  close(safety.captureOpportunity[0], 0);
  close(safety.threatLoss[0], 0);
  const home = AI.evaluate(fixture([51, 55, 56, -1], [49, 50, 51, 55]), 0).features;
  close(home.captureOpportunity[0], 0);
  close(home.threatLoss[0], 0);
});

test('风险特征是新回合布局投影，不随当前6连掷计数冒充实际概率', () => {
  const state = fixture([10, -1, -1, -1], [35, -1, -1, -1]);
  const features = AI.evaluate(state, 0).features;
  const currentSix = { ...state, phase: 'awaitingMove', pendingDie: 6, consecutiveSixes: 2 };
  assert.deepEqual(AI.evaluate(currentSix, 0).features.threatLoss, features.threatLoss);
  assert.deepEqual(AI.evaluate(currentSix, 0).features.mobility, features.mobility);
});

test('机动性根据等价后继去重，四枚基地棋子出营只算一种选择', () => {
  const features = AI.evaluate(E.createGame(0), 0).features;
  close(features.mobility[0], 1 / 24);
  close(features.mobility[1], 1 / 24);
  close(features.noActionProbability[0], 5 / 6);
  const second = AI.evaluate(fixture([0, 0, -1, -1]), 0).features;
  close(second.mobility[0], 7 / 24);
  close(second.noActionProbability[0], 0);
});

test('等价出营动作仅保留最小棋子编号，6仍保留场内推进候选', () => {
  assert.deepEqual(AI.rankActions(E.applyRoll(E.createGame(0), 6)).map(x => x.action), [0]);
  const state = rolled([0, -1, -1, -1], undefined, 6);
  assert.deepEqual(AI.rankActions(state).map(x => x.action).sort(), [0, 1]);
});

test('初级随机是在不同后继间均匀选取，不让基地重复棋子放大概率', () => {
  const state = rolled([0, -1, -1, -1], undefined, 6);
  const actions = [];
  for (let bucket = 0; bucket < 100; bucket += 1) {
    actions.push(AI.chooseAction(state, 'beginner', () => (bucket + 0.5) / 100).action);
  }
  const counts = new Map();
  actions.forEach(action => counts.set(action, (counts.get(action) || 0) + 1));
  assert.deepEqual([...counts.values()].sort(), [50, 50]);
  assert.ok(actions.every(action => action === 0 || action === 1));
});

test('初级和中级均优先立即赢下整局', () => {
  for (const player of [0, 1]) {
    const own = [56, 56, 55, 56];
    const state = player === 0 ? rolled(own, undefined, 1, player) : rolled(undefined, own, 1, player);
    for (const difficulty of ['beginner', 'medium']) {
      const result = AI.chooseAction(state, difficulty, () => 0.99);
      assert.equal(result.action, 2);
      assert.equal(E.applyAction(state, result.action).winner, player);
    }
  }
});

test('中级固定战术：相同推进距离优先安全捕获远行敌子', () => {
  const state = rolled([12, 1, -1, -1], [42, -1, -1, -1], 4);
  const result = AI.chooseAction(state, 'medium', () => 0.99);
  assert.equal(result.action, 0);
  assert.equal(E.applyAction(state, result.action).tokenProgress[1][0], -1);
  assert.ok(Number.isFinite(result.score));
});

test('候选评分完整、降序稳定、解释可用且未获胜分数有界', () => {
  const state = rolled([0, 12, 27, -1], [4, 18, 45, -1], 6);
  const ranked = AI.rankActions(state);
  assert.equal(ranked.length, 4);
  const seen = new Set();
  for (let index = 0; index < ranked.length; index += 1) {
    const entry = ranked[index];
    assert.ok(E.getLegalActions(state).includes(entry.action));
    assert.ok(Number.isFinite(entry.score) && Math.abs(entry.score) < 0.95);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0);
    assert.ok(entry.features && typeof entry.features === 'object');
    seen.add(entry.action);
    if (index > 0) assert.ok(ranked[index - 1].score >= entry.score);
  }
  assert.equal(seen.size, 4);
});

test('无可选走法时AI返回空动作，不自行掷骰或改状态', () => {
  const state = E.createGame(0);
  const before = JSON.stringify(state);
  assert.equal(AI.chooseAction(state, 'medium').action, null);
  assert.deepEqual(AI.rankActions(state), []);
  assert.equal(JSON.stringify(state), before);
});

test('AI分析不改变输入，真实骰源序列不受难度或策略随机消费影响', () => {
  const state = rolled([0, 12, 27, -1], [4, 18, 45, -1], 6);
  const snapshot = JSON.stringify(state);
  function run(extraStrategyCalls) {
    const dice = AI.createSeededRng(12345);
    const strategy = AI.createSeededRng(98765);
    const result = [];
    for (let index = 0; index < 30; index += 1) {
      for (let extra = 0; extra < extraStrategyCalls; extra += 1) AI.chooseAction(state, 'beginner', strategy);
      AI.chooseAction(state, index % 2 ? 'beginner' : 'medium', strategy);
      result.push(Math.floor(dice() * 6) + 1);
    }
    return result;
  }
  assert.deepEqual(run(0), run(11));
  assert.equal(JSON.stringify(state), snapshot);
});

test('种子随机源可复现、实例独立且输出在[0,1)内', () => {
  const a = AI.createSeededRng(314159);
  const b = AI.createSeededRng(314159);
  const c = AI.createSeededRng(271828);
  const sa = Array.from({ length: 100 }, () => a());
  const sb = Array.from({ length: 100 }, () => b());
  const sc = Array.from({ length: 100 }, () => c());
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.ok(sa.every(value => value >= 0 && value < 1));
});
