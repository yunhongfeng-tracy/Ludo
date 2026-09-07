'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');

function fixture(red = [-1, -1, -1, -1], yellow = [-1, -1, -1, -1], options = {}) {
  return { ...E.createGame(0), tokenProgress: [red.slice(), yellow.slice()], ...options };
}
function moveState(red, yellow, die, player = 0, consecutiveSixes = die === 6 ? 1 : 0) {
  return fixture(red, yellow, { activePlayer: player, phase: 'awaitingMove', pendingDie: die, consecutiveSixes });
}
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('新局有双方四子，可显式选择先手', () => {
  for (const first of [0, 1]) {
    const state = E.createGame(first);
    assert.equal(state.activePlayer, first);
    assert.equal(state.phase, 'awaitingRoll');
    assert.equal(state.pendingDie, null);
    assert.equal(state.consecutiveSixes, 0);
    assert.equal(E.getTerminalResult(state), null);
    assert.deepEqual(state.tokenProgress, [[-1, -1, -1, -1], [-1, -1, -1, -1]]);
    E.validateState(state);
  }
});

test('状态复制不共享棋子数组', () => {
  const original = E.createGame(0);
  const copied = E.cloneState(original);
  assert.deepEqual(copied, original);
  copied.tokenProgress[0][0] = 0;
  assert.equal(original.tokenProgress[0][0], -1);
});

test('整个物理环路和双方通道与手工路线核对', () => {
  const expectedRing = [
    [13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
    [7,0],[6,0],[6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],
    [0,6],[0,7],[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],
    [6,12],[6,13],[6,14],[7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
    [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],
  ];
  assert.equal(E.FINISH, 56);
  assert.equal(E.RING.length, 52);
  assert.equal(E.HOME_PATHS.length, 2);
  const ringIds = new Set();
  for (let player = 0; player < 2; player += 1) {
    for (let progress = 0; progress <= 50; progress += 1) {
      const pos = E.position(player, progress);
      assert.equal(pos.zone, 'ring');
      assert.deepEqual([pos.row, pos.col], expectedRing[(player * 26 + progress) % 52]);
      ringIds.add(pos.cellId);
    }
    for (let progress = 51; progress <= 55; progress += 1) {
      const pos = E.position(player, progress);
      assert.equal(pos.zone, 'home');
      assert.deepEqual([pos.row, pos.col], [player === 0 ? 64 - progress : progress - 50, 7]);
    }
    const finish = E.position(player, 56);
    assert.equal(finish.zone, 'finish');
    assert.deepEqual([finish.row, finish.col], [player === 0 ? 8 : 6, 7]);
    assert.equal(E.position(player, -1).zone, 'yard');
  }
  assert.equal(ringIds.size, 52);
  assert.notEqual(E.position(0, 51).cellId, E.position(1, 51).cellId);
});

test('两色相对进度差26时指向同一公共格', () => {
  for (let progress = 0; progress <= 24; progress += 1) {
    assert.equal(E.position(0, progress).cellId, E.position(1, progress + 26).cellId);
    assert.equal(E.position(1, progress).cellId, E.position(0, progress + 26).cellId);
  }
});

for (const die of [1, 2, 3, 4, 5]) {
  test(`基地棋子掷 ${die} 不出营，无合法动作自动换人`, () => {
    const state = E.applyRoll(E.createGame(0), die);
    assert.equal(state.phase, 'awaitingRoll');
    assert.equal(state.activePlayer, 1);
    assert.equal(state.pendingDie, null);
    assert.deepEqual(state.tokenProgress[0], [-1, -1, -1, -1]);
  });
}

test('掷6可选出营或场内推进，出营只到本色起点', () => {
  const rolled = E.applyRoll(fixture([10, -1, 56, 55]), 6);
  assert.deepEqual(E.getLegalActions(rolled), [0, 1]);
  const enter = E.applyAction(rolled, 1);
  assert.equal(enter.tokenProgress[0][1], 0);
  assert.equal(enter.activePlayer, 0);
  assert.equal(enter.consecutiveSixes, 1);
  const advance = E.applyAction(rolled, 0);
  assert.equal(advance.tokenProgress[0][0], 16);
});

test('第一次第二次6继续行动，第三次6不走棋且保留前两步', () => {
  let state = E.createGame(0);
  state = E.applyAction(E.applyRoll(state, 6), 0);
  assert.equal(state.consecutiveSixes, 1);
  state = E.applyAction(E.applyRoll(state, 6), 0);
  assert.equal(state.tokenProgress[0][0], 6);
  assert.equal(state.consecutiveSixes, 2);
  const before = JSON.stringify(state.tokenProgress);
  state = E.applyRoll(state, 6);
  assert.equal(JSON.stringify(state.tokenProgress), before);
  assert.equal(state.activePlayer, 1);
  assert.equal(state.phase, 'awaitingRoll');
  assert.equal(state.pendingDie, null);
  assert.equal(state.consecutiveSixes, 0);
});

test('非6在已有连续计数后走棋并换人，归零计数', () => {
  const rolled = E.applyRoll(fixture([10, -1, -1, -1], undefined, { consecutiveSixes: 2 }), 4);
  assert.equal(rolled.consecutiveSixes, 0);
  const state = E.applyAction(rolled, 0);
  assert.equal(state.activePlayer, 1);
  assert.equal(state.consecutiveSixes, 0);
});

test('6无合法动作仍再掷，累计到第三个6才换人', () => {
  let state = fixture([55, 56, 56, 56]);
  state = E.applyRoll(state, 6);
  assert.equal(state.activePlayer, 0);
  assert.equal(state.phase, 'awaitingRoll');
  assert.equal(state.consecutiveSixes, 1);
  state = E.applyRoll(state, 6);
  assert.equal(state.activePlayer, 0);
  assert.equal(state.consecutiveSixes, 2);
  state = E.applyRoll(state, 6);
  assert.equal(state.activePlayer, 1);
  assert.equal(state.consecutiveSixes, 0);
});

for (const player of [0, 1]) {
  test(`阵营 ${player} 普通落点吃掉全部敌方叠子，不奖励再掷`, () => {
    const own = [0, -1, -1, -1];
    const opponent = [30, 30, 30, -1];
    const state = player === 0 ? moveState(own, opponent, 4, player) : moveState(opponent, own, 4, player);
    const next = E.applyAction(state, 0);
    assert.equal(next.tokenProgress[player][0], 4);
    assert.deepEqual(next.tokenProgress[1 - player], [-1, -1, -1, -1]);
    assert.equal(next.activePlayer, 1 - player);
  });
  test(`阵营 ${player} 经过敌方叠子不吃也不被封路`, () => {
    const own = [0, -1, -1, -1];
    const opponent = [28, 28, -1, -1];
    const state = player === 0 ? moveState(own, opponent, 4, player) : moveState(opponent, own, 4, player);
    const next = E.applyAction(state, 0);
    assert.equal(next.tokenProgress[player][0], 4);
    assert.deepEqual(next.tokenProgress[1 - player], opponent);
  });
  test(`阵营 ${player} 可以与己方同格，经过己方叠子不封路`, () => {
    const own = [0, 4, 2, 2];
    const state = player === 0 ? moveState(own, undefined, 4, player) : moveState(undefined, own, 4, player);
    const next = E.applyAction(state, 0);
    assert.deepEqual(next.tokenProgress[player], [4, 4, 2, 2]);
  });
  test(`阵营 ${player} 专属通道入口和终点精确落位`, () => {
    let own = [50, 55, 56, -1];
    let state = player === 0 ? moveState(own, undefined, 1, player) : moveState(undefined, own, 1, player);
    assert.deepEqual(E.getLegalActions(state), [0, 1]);
    assert.equal(E.applyAction(state, 0).tokenProgress[player][0], 51);
    const finishedOne = E.applyAction(state, 1);
    assert.equal(finishedOne.tokenProgress[player][1], 56);
    assert.equal(finishedOne.activePlayer, 1 - player);
    assert.equal(finishedOne.winner, null);
    state = player === 0 ? moveState(own, undefined, 2, player) : moveState(undefined, own, 2, player);
    assert.deepEqual(E.getLegalActions(state), [0]);
    assert.throws(() => E.applyAction(state, 1));
  });
  test(`阵营 ${player} 最后一子到家立即终局，6也不再掷`, () => {
    const own = [50, 56, 56, 56];
    const state = player === 0 ? moveState(own, undefined, 6, player) : moveState(undefined, own, 6, player);
    const won = E.applyAction(state, 0);
    assert.equal(won.phase, 'finished');
    assert.equal(E.getTerminalResult(won), player);
    assert.equal(won.winner, player);
    assert.equal(won.pendingDie, null);
    assert.deepEqual(E.getLegalActions(won), []);
    assert.throws(() => E.applyRoll(won, 1));
    assert.throws(() => E.applyAction(won, 0));
    E.validateState(won);
  });
}

for (const globalCell of [0, 8, 13, 21, 26, 34, 39, 47]) {
  test(`安全格 ${globalCell} 双方可以共存且不吃叠子`, () => {
    const player = globalCell === 0 || globalCell === 26 ? (globalCell === 0 ? 1 : 0) : 0;
    const ownTarget = (globalCell - player * 26 + 52) % 52;
    const enemyTarget = (globalCell - (1 - player) * 26 + 52) % 52;
    const own = [ownTarget - 1, -1, -1, -1];
    const enemy = [enemyTarget, enemyTarget, -1, -1];
    const state = player === 0 ? moveState(own, enemy, 1, player) : moveState(enemy, own, 1, player);
    const next = E.applyAction(state, 0);
    assert.equal(next.tokenProgress[player][0], ownTarget);
    assert.deepEqual(next.tokenProgress[1 - player], enemy);
  });
}

test('掷6出营可与敌子同占起点安全格', () => {
  const state = E.applyAction(moveState([-1, -1, -1, -1], [26, 26, -1, -1], 6), 0);
  assert.equal(state.tokenProgress[0][0], 0);
  assert.deepEqual(state.tokenProgress[1], [26, 26, -1, -1]);
});

test('双方归家通道不会因相同进度发生吃子', () => {
  const state = E.applyAction(moveState([51, -1, -1, -1], [52, 52, -1, -1], 1), 0);
  assert.deepEqual(state.tokenProgress, [[52, -1, -1, -1], [52, 52, -1, -1]]);
});

test('规则计算接受冻结输入且不暗中使用随机数', () => {
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('规则引擎不能使用随机数'); };
  try {
    const state = freezeDeep(fixture([0, -1, -1, -1], [30, -1, -1, -1]));
    const snapshot = JSON.stringify(state);
    const rolled = freezeDeep(E.applyRoll(state, 4));
    const moved = E.applyAction(rolled, 0);
    assert.equal(moved.tokenProgress[0][0], 4);
    assert.equal(moved.tokenProgress[1][0], -1);
    assert.equal(JSON.stringify(state), snapshot);
    assert.equal(rolled.tokenProgress[0][0], 0);
  } finally {
    Math.random = originalRandom;
  }
});

test('非法骰点、动作编号、错误阶段明确拒绝', () => {
  const initial = E.createGame(0);
  for (const die of [0, 7, -1, 1.5, NaN, Infinity, '6', null, undefined]) {
    assert.throws(() => E.applyRoll(initial, die));
  }
  const rolled = E.applyRoll(initial, 6);
  for (const action of [-1, 4, 1.5, NaN, '0', null, undefined]) {
    assert.throws(() => E.applyAction(rolled, action));
  }
  assert.throws(() => E.applyAction(initial, 0));
  assert.throws(() => E.applyRoll(rolled, 1));
});

test('状态校验拒绝越界和矛盾状态', () => {
  const invalid = [
    { activePlayer: 2 }, { activePlayer: -1 }, { phase: 'thinking' },
    { tokenProgress: [[-2, -1, -1, -1], [-1, -1, -1, -1]] },
    { tokenProgress: [[57, -1, -1, -1], [-1, -1, -1, -1]] },
    { tokenProgress: [[0.5, -1, -1, -1], [-1, -1, -1, -1]] },
    { tokenProgress: [[-1, -1, -1], [-1, -1, -1, -1]] },
    { pendingDie: 4 }, { consecutiveSixes: 3 }, { consecutiveSixes: -1 },
    { winner: 0 }, { phase: 'finished', winner: 0 },
    { phase: 'awaitingMove', pendingDie: null },
  ];
  for (const change of invalid) assert.throws(() => E.validateState({ ...E.createGame(0), ...change }), JSON.stringify(change));
});

test('完整状态键保留回合信息，规范键只消除棋子编号置换', () => {
  const a = fixture([1, 9, -1, 56], [3, 22, -1, 55]);
  const b = fixture([56, -1, 9, 1], [55, -1, 22, 3]);
  assert.notEqual(E.stateKey(a), E.stateKey(b));
  assert.equal(E.stateKey(a, { canonicalTokens: true }), E.stateKey(b, { canonicalTokens: true }));
  assert.notEqual(E.stateKey(a), E.stateKey({ ...a, activePlayer: 1 }));
  assert.notEqual(E.stateKey(a), E.stateKey({ ...a, consecutiveSixes: 1 }));
  assert.notEqual(E.stateKey(E.applyRoll(a, 1)), E.stateKey(E.applyRoll(a, 2)));
});

test('多局可达状态不变量：合法性、推进边界、终局和输入不变', () => {
  let seed = 0x53e8911d;
  function nextInt(max) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  }
  let completed = 0;
  let rolls = 0;
  for (let game = 0; game < 12; game += 1) {
    let state = E.createGame(game % 2);
    for (let step = 0; step < 10000 && state.phase !== 'finished'; step += 1) {
      const before = JSON.stringify(state);
      const die = nextInt(6) + 1;
      const rolled = E.applyRoll(state, die);
      rolls += 1;
      assert.equal(JSON.stringify(state), before);
      E.validateState(rolled);
      if (rolled.phase === 'awaitingMove') {
        const actions = E.getLegalActions(rolled);
        const expected = rolled.tokenProgress[rolled.activePlayer]
          .map((progress, id) => ({ progress, id }))
          .filter(({ progress }) => progress === -1 ? die === 6 : progress < 56 && progress + die <= 56)
          .map(({ id }) => id);
        assert.deepEqual(actions, expected);
        assert.ok(actions.length > 0);
        const rollSnapshot = JSON.stringify(rolled);
        state = E.applyAction(rolled, actions[nextInt(actions.length)]);
        assert.equal(JSON.stringify(rolled), rollSnapshot);
      } else state = rolled;
      E.validateState(state);
      assert.equal(state.tokenProgress.flat().length, 8);
      assert.ok(state.tokenProgress.flat().every(p => Number.isInteger(p) && p >= -1 && p <= 56));
    }
    assert.equal(state.phase, 'finished', `game=${game}`);
    assert.equal(state.tokenProgress[state.winner].filter(p => p === 56).length, 4);
    completed += 1;
  }
  assert.equal(completed, 12);
  assert.ok(rolls > 100);
});
