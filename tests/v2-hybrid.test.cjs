'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const Classic = require('../src/ai.js');
const H = require('../src/ai-v2-hybrid-eval.js');

function fixture(red = [-1, -1, -1, -1], yellow = [-1, -1, -1, -1], options = {}) {
  return { ...E.createGame(0), tokenProgress: [red.slice(), yellow.slice()], ...options };
}
function close(actual, expected, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-11, `${label}: ${actual} != ${expected}`);
}
function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}

test('hybrid禁用修正时与Classic原公式一致，覆盖随机局面与已知骰点', () => {
  let seed = 71037;
  for (let sample = 0; sample < 300; sample += 1) {
    const sides = [0, 1].map(() => Array.from({ length: 4 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % 58 - 1;
    }));
    let state = fixture(sides[0], sides[1], { activePlayer: sample % 2, consecutiveSixes: sample % 3 });
    if (sample % 2) state = E.applyRoll(state, sample % 6 + 1);
    for (const perspective of [0, 1]) {
      const reference = Classic.evaluate(state, perspective);
      const hybrid = H.evaluate(state, perspective, 'classic');
      close(hybrid.value, reference.value, `sample ${sample}`);
      close(hybrid.features.classicZ, reference.features.z);
      for (const player of [0, 1]) {
        close(hybrid.features.position[player], reference.features.position[player]);
        close(hybrid.features.mobility[player], reference.features.mobility[player]);
        close(hybrid.features.freshThreatLoss[player], reference.features.threatLoss[player]);
      }
      close(H.fastValue(state, perspective, 'classic'), reference.value);
    }
  }
});

test('完整hybrid只增加约定的归家效率和行动顺序风险修正', () => {
  const state = fixture([54, 55, 10, 56], [30, 56, 56, 56]);
  const classic = Classic.evaluate(state, 0);
  const hybrid = H.evaluate(state, 0);
  close(hybrid.features.homeCorrection, 0.03 * 3);
  close(hybrid.features.z, classic.features.z + hybrid.features.homeCorrection + hybrid.features.turnCorrection);
  close(H.fastValue(state, 0), hybrid.value);
  assert.ok(H.PROFILES.full.homeEfficiency < 0.1);
});

test('当前已知骰点、连续第三个6和远端行动风险按约定修正', () => {
  const red = [10, -1, -1, -1];
  const yellow = [30, -1, -1, -1];
  const fresh = fixture(red, yellow, { activePlayer: 1 });
  const amount = H.evaluate(fresh, 0).features.threatLoss[0];
  assert.ok(amount > 0);
  close(H.evaluate(fixture(red, yellow), 0).features.threatLoss[0], amount * H.PROFILES.full.delayedThreat);
  close(H.evaluate({ ...fresh, consecutiveSixes: 2 }, 0).features.threatLoss[0], 0);
  close(H.evaluate(E.applyRoll(fresh, 6), 0).features.threatLoss[0], amount * 6);
});

test('安全格无吃子风险，叠子风险按被吃总损失计算', () => {
  close(H.evaluate(fixture([8, 8, 51, 55], [33, 33, -1, -1]), 0).features.threatLoss[0], 0);
  const single = H.evaluate(fixture([10, -1, -1, -1], [35, -1, -1, -1]), 0).features.threatLoss[0];
  const stacked = H.evaluate(fixture([10, 10, -1, -1], [35, 35, -1, -1]), 0).features.threatLoss[0];
  close(stacked, 2 * single);
});

test('阵营和活动方交换后反号，棋子置换不改评分，输入冻结不被修改', () => {
  const state = deepFreeze(fixture([54, 55, 10, 56], [30, -1, 56, 56], { activePlayer: 1, consecutiveSixes: 2 }));
  const before = JSON.stringify(state);
  const swapped = fixture(state.tokenProgress[1], state.tokenProgress[0], { activePlayer: 0, consecutiveSixes: 2 });
  const permuted = fixture([56, 10, 55, 54], [56, 56, -1, 30], { activePlayer: 1, consecutiveSixes: 2 });
  close(H.fastValue(state, 0), -H.fastValue(state, 1));
  close(H.fastValue(state, 0), -H.fastValue(swapped, 0));
  close(H.fastValue(state, 0), H.fastValue(permuted, 0));
  assert.equal(JSON.stringify(state), before);
});

test('真实终局±1，非终局严格有界，公开入口拒绝非法状态及配置', () => {
  const before = E.applyRoll(fixture([55, 56, 56, 56]), 1);
  const won = E.applyAction(before, 0);
  assert.equal(H.evaluate(won, 0).value, 1);
  assert.equal(H.fastValue(won, 1), -1);
  assert.ok(H.fastValue(before, 0) < 0.95);
  assert.ok(H.fastValue(before, 1) > -0.95);
  assert.throws(() => H.evaluate({ ...before, rulesetId: 'different' }, 0));
  assert.throws(() => H.evaluate(before, 2));
  assert.throws(() => H.evaluate(before, 0, 'new-profile'));
  assert.ok(Object.isFrozen(H.PROFILES.full));
});
