'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const V = require('../src/ai-v2-eval.js');

function fixture(red = [-1, -1, -1, -1], yellow = [-1, -1, -1, -1], options = {}) {
  return { ...E.createGame(0), tokenProgress: [red.slice(), yellow.slice()], ...options };
}
function close(actual, expected, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
}
function freeze(value) {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); });
  return Object.freeze(value);
}

// 独立参考：只使用真实棋规构造马尔可夫转移，再从零做有限视野价值迭代。
// 不复用被测模块的三元消元过程。对手等待期间不消耗己方掷骰次数。
function referenceSingleCosts() {
  const width = 58;
  const transitions = [];
  for (let streak = 0; streak < 3; streak += 1) {
    for (let progress = -1; progress <= 56; progress += 1) {
      const row = [];
      if (progress < 56) {
        const state = fixture([progress, 56, 56, 56], undefined, { consecutiveSixes: streak });
        for (let die = 1; die <= 6; die += 1) {
          let next = E.applyRoll(state, die);
          if (next.phase === 'awaitingMove') next = E.applyAction(next, 0);
          row.push(next.winner === 0 ? -1 : next.consecutiveSixes * width + next.tokenProgress[0][0] + 1);
        }
      }
      transitions.push(row);
    }
  }
  let values = new Float64Array(width * 3);
  let converged = false;
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const next = new Float64Array(values.length);
    let delta = 0;
    for (let index = 0; index < values.length; index += 1) {
      if (transitions[index].length === 0) continue;
      next[index] = 1 + transitions[index].reduce((sum, child) => sum + (child < 0 ? 0 : values[child]), 0) / 6;
      delta = Math.max(delta, Math.abs(next[index] - values[index]));
    }
    values = next;
    if (delta < 1e-12) { converged = true; break; }
  }
  assert.ok(converged, '独立期望参考应收敛');
  return values;
}

function referenceCapture(state, actor) {
  let sum = 0;
  const victim = 1 - actor;
  const dice = state.activePlayer === actor && state.phase === 'awaitingMove' ? [state.pendingDie] : [1, 2, 3, 4, 5, 6];
  for (const die of dice) {
    const projected = { ...state, activePlayer: actor, phase: 'awaitingRoll', pendingDie: null,
      consecutiveSixes: state.activePlayer === actor && state.phase === 'awaitingRoll' ? state.consecutiveSixes : 0 };
    const rolled = dice.length === 1 ? state : E.applyRoll(projected, die);
    let best = 0;
    for (const action of E.getLegalActions(rolled)) {
      const after = E.applyAction(rolled, action);
      let loss = 0;
      for (let token = 0; token < 4; token += 1) {
        if (state.tokenProgress[victim][token] >= 0 && after.tokenProgress[victim][token] === -1) {
          loss += V.expectedRolls(-1) - V.expectedRolls(state.tokenProgress[victim][token]);
        }
      }
      best = Math.max(best, loss);
    }
    sum += best / dice.length;
  }
  return sum * (state.activePlayer === actor ? 1 : V.PROFILES.full.delayedThreat);
}

test('单子掷骰成本与真实棋规的独立价值迭代一致，覆盖全部位置及连续6', () => {
  const reference = referenceSingleCosts();
  for (let streak = 0; streak < 3; streak += 1) {
    for (let progress = -1; progress <= 56; progress += 1) {
      close(V.expectedRolls(progress, streak), reference[streak * 58 + progress + 1], `p=${progress}, sixes=${streak}`);
    }
  }
});

test('基地必须等6，精确到家等待不按距离线性缩短，第三个6不能前进', () => {
  close(V.expectedRolls(55), 6);
  close(V.expectedRolls(51), 6);
  close(V.expectedRolls(-1), 6 + V.expectedRolls(0, 1));
  assert.ok(V.expectedRolls(50, 2) > V.expectedRolls(50, 0));
  close(V.expectedRolls(56, 2), 0);
});

test('归家子问题包含多子共享骰点等待，单子及同尾数有独立已知解', () => {
  close(V.expectedHomeRolls([55, 56, 56, 56]), 6);
  close(V.expectedHomeRolls([55, 55, 56, 56]), 12);
  close(V.expectedHomeRolls([54, 55, 56, 56]), 9);
  close(V.expectedHomeRolls([56, 56, 56, 56]), 0);
});

test('归家四子成本满足引擎定义的最优贝尔曼方程，包含无走法和三连6', () => {
  let seed = 2026;
  for (let sample = 0; sample < 90; sample += 1) {
    const tokens = Array.from({ length: 4 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 50 + seed % 7;
    });
    if (tokens.every(p => p === 56)) continue;
    const streak = sample % 3;
    const state = fixture(tokens, undefined, { consecutiveSixes: streak });
    let reference = 1;
    for (let die = 1; die <= 6; die += 1) {
      const rolled = E.applyRoll(state, die);
      const actions = E.getLegalActions(rolled);
      const nextStates = actions.length ? actions.map(action => E.applyAction(rolled, action)) : [rolled];
      reference += Math.min(...nextStates.map(next => next.winner === 0 ? 0
        : V.expectedHomeRolls(next.tokenProgress[0], next.consecutiveSixes))) / 6;
    }
    close(V.expectedHomeRolls(tokens, streak), reference, JSON.stringify(tokens));
  }
});

test('阵营与行动方一同交换后反号，改变视角也严格反号', () => {
  const state = fixture([5, 40, 51, -1], [7, 34, 55, 56], { activePlayer: 1, consecutiveSixes: 2 });
  const swapped = fixture(state.tokenProgress[1], state.tokenProgress[0], { activePlayer: 0, consecutiveSixes: 2 });
  for (const profile of Object.keys(V.PROFILES)) {
    close(V.fastValue(state, 0, profile), -V.fastValue(state, 1, profile));
    close(V.fastValue(state, 0, profile), -V.fastValue(swapped, 0, profile));
  }
});

test('棋子置换不改变评分，fastValue与公共入口一致，输入深冻结不被改写', () => {
  const state = freeze(fixture([54, 51, 20, 56], [4, 39, -1, 56]));
  const before = JSON.stringify(state);
  const permuted = fixture([56, 20, 51, 54], [56, -1, 39, 4]);
  for (const profile of Object.keys(V.PROFILES)) {
    close(V.evaluate(state, 0, profile).value, V.fastValue(state, 0, profile));
    close(V.fastValue(state, 0, profile), V.fastValue(permuted, 0, profile));
  }
  assert.equal(JSON.stringify(state), before);
});

test('胜负只能由真实终局给出±1，优势局面严格小于0.95', () => {
  const before = E.applyRoll(fixture([55, 56, 56, 56]), 1);
  const won = E.applyAction(before, 0);
  for (const profile of Object.keys(V.PROFILES)) {
    assert.equal(V.fastValue(won, 0, profile), 1);
    assert.equal(V.evaluate(won, 1, profile).value, -1);
    assert.ok(V.fastValue(before, 0, profile) < 0.95);
    assert.ok(V.fastValue(before, 1, profile) > -0.95);
  }
});

test('风险距离查表与引擎真实合法吃子一致，覆盖随机布局、轮次和连续6', () => {
  let seed = 17431;
  for (let sample = 0; sample < 250; sample += 1) {
    const sides = [0, 1].map(() => Array.from({ length: 4 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % 58 - 1;
    }));
    const state = fixture(sides[0], sides[1], { activePlayer: sample % 2, consecutiveSixes: sample % 3 });
    const features = V.evaluate(state, 0).features;
    close(features.threatLoss[0], referenceCapture(state, 1), `red sample=${sample}`);
    close(features.threatLoss[1], referenceCapture(state, 0), `yellow sample=${sample}`);
  }
});

test('安全格和归家通道不可被吃，同格多子计入全部损失而进攻重复子不重复算', () => {
  const safe = V.evaluate(fixture([8, 8, 51, 55], [33, 33, -1, -1]), 0).features;
  close(safe.threatLoss[0], 0);
  const one = V.evaluate(fixture([10, -1, -1, -1], [35, -1, -1, -1]), 0).features;
  const duplicate = V.evaluate(fixture([10, 10, -1, -1], [35, 35, -1, -1]), 0).features;
  close(duplicate.threatLoss[0], 2 * one.threatLoss[0]);
});

test('当前行动方风险更紧迫，实际待走骰点按已知结果处理，第三个6无法吃子', () => {
  const redTurn = fixture([10, -1, -1, -1], [30, -1, -1, -1]);
  const yellowTurn = { ...redTurn, activePlayer: 1 };
  const a = V.evaluate(redTurn, 0).features.threatLoss[0];
  const b = V.evaluate(yellowTurn, 0).features.threatLoss[0];
  close(a, b * V.PROFILES.full.delayedThreat);
  assert.ok(b > a);
  close(V.evaluate({ ...yellowTurn, consecutiveSixes: 2 }, 0).features.threatLoss[0], 0);
  const rolled = E.applyRoll(yellowTurn, 6);
  close(V.evaluate(rolled, 0).features.threatLoss[0], b * 6);
});

test('残局两种尾数的完成效率能与相同尾数区分，但不把启发评分当作胜率', () => {
  const diversified = fixture([54, 55, 56, 56], [55, 55, 56, 56]);
  const costOnly = V.evaluate(diversified, 0, 'cost-only');
  const race = V.evaluate(diversified, 0, 'race');
  close(costOnly.value, 0);
  close(race.features.completionEfficiency[0], 3);
  close(race.features.completionEfficiency[1], 0);
  assert.ok(race.value > 0);
  assert.ok(race.value < 0.95);
});

test('公开入口拒绝错误状态、视角和配置，配置不可变', () => {
  assert.throws(() => V.evaluate({ ...E.createGame(), rulesetId: 'new-rules' }, 0));
  assert.throws(() => V.evaluate(E.createGame(), 2));
  assert.throws(() => V.evaluate(E.createGame(), 0, 'invented'));
  assert.throws(() => V.expectedRolls(-2));
  assert.throws(() => V.expectedRolls(0, 3));
  assert.throws(() => V.expectedHomeRolls([49, 55, 56, 56]));
  assert.throws(() => V.expectedHomeRolls([55, 56, 56]));
  assert.ok(Object.isFrozen(V.PROFILES));
  assert.ok(Object.isFrozen(V.PROFILES.full));
});
