(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.LudoV2Eval = factory(root.LudoEngine);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  if (!Engine) throw new Error('LudoV2Eval requires LudoEngine.');
  const VERSION = 'own-roll-cost-home-race-threat@1';
  const FINISH = Engine.FINISH;
  const WIDTH = FINISH + 2;
  const HOME_SIZE = 7 * 7 * 7 * 7;
  const POWERS = [1, 7, 49, 343];
  // 权重是待对战验证的启发式初值，不是拟合胜率或最优解。
  const PROFILES = Object.freeze({
    'cost-only': Object.freeze({ completion: 0, mobility: 0, threat: 0, tempo: 0, delayedThreat: 0.55, scale: 22 }),
    race: Object.freeze({ completion: 1, mobility: 1.5, threat: 0, tempo: 0, delayedThreat: 0.55, scale: 22 }),
    full: Object.freeze({ completion: 1, mobility: 1.5, threat: 0.75, tempo: 0.5, delayedThreat: 0.55, scale: 22 })
  });
  const SINGLE_COSTS = new Float64Array(WIDTH * 3);
  const HOME_COSTS = new Float64Array(HOME_SIZE * 3).fill(-1);
  const LEGAL_MASKS = new Uint8Array(WIDTH);
  const POPCOUNT = new Uint8Array(64);
  const UNSAFE = [new Uint8Array(WIDTH), new Uint8Array(WIDTH)];
  const PHYSICAL = [new Int8Array(WIDTH), new Int8Array(WIDTH)];

  function solveThree(matrix, rhs) {
    // 每个局面只有连续 6 计数产生的三个自环，消元后即可得到精确期望。
    for (let column = 0; column < 3; column += 1) {
      const diagonal = matrix[column][column];
      for (let entry = column; entry < 3; entry += 1) matrix[column][entry] /= diagonal;
      rhs[column] /= diagonal;
      for (let row = 0; row < 3; row += 1) {
        if (row === column) continue;
        const factor = matrix[row][column];
        for (let entry = column; entry < 3; entry += 1) matrix[row][entry] -= factor * matrix[column][entry];
        rhs[row] -= factor * rhs[column];
      }
    }
    return rhs;
  }

  function initializeSingleCosts() {
    for (let progress = FINISH - 1; progress >= -1; progress -= 1) {
      const matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const rhs = [1, 1, 1];
      for (let streak = 0; streak < 3; streak += 1) {
        for (let die = 1; die <= 6; die += 1) {
          const thirdSix = die === 6 && streak === 2;
          const nextStreak = die === 6 && !thirdSix ? streak + 1 : 0;
          let nextProgress = progress;
          if (!thirdSix && (progress === -1 ? die === 6 : progress + die <= FINISH)) {
            nextProgress = progress === -1 ? 0 : progress + die;
          }
          if (nextProgress === progress) matrix[streak][nextStreak] -= 1 / 6;
          else rhs[streak] += SINGLE_COSTS[nextStreak * WIDTH + nextProgress + 1] / 6;
        }
      }
      const costs = solveThree(matrix, rhs);
      for (let streak = 0; streak < 3; streak += 1) SINGLE_COSTS[streak * WIDTH + progress + 1] = costs[streak];
    }
  }

  function initializeHomeCosts(key) {
    if (HOME_COSTS[key] >= 0) return;
    if (key === 0) {
      for (let streak = 0; streak < 3; streak += 1) HOME_COSTS[streak * HOME_SIZE] = 0;
      return;
    }
    let encoded = key;
    const distances = [];
    for (let token = 0; token < 4; token += 1) {
      distances.push(encoded % 7);
      encoded = Math.floor(encoded / 7);
    }
    const matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const rhs = [1, 1, 1];
    for (let streak = 0; streak < 3; streak += 1) {
      for (let die = 1; die <= 6; die += 1) {
        const thirdSix = die === 6 && streak === 2;
        const nextStreak = die === 6 && !thirdSix ? streak + 1 : 0;
        let best = Infinity;
        if (!thirdSix) {
          for (let token = 0; token < 4; token += 1) {
            if (distances[token] < die) continue;
            const childKey = key - POWERS[token] * die;
            initializeHomeCosts(childKey);
            best = Math.min(best, HOME_COSTS[nextStreak * HOME_SIZE + childKey]);
          }
        }
        if (best === Infinity) matrix[streak][nextStreak] -= 1 / 6;
        else rhs[streak] += best / 6;
      }
    }
    const costs = solveThree(matrix, rhs);
    for (let streak = 0; streak < 3; streak += 1) HOME_COSTS[streak * HOME_SIZE + key] = costs[streak];
  }

  initializeSingleCosts();
  for (let key = 0; key < HOME_SIZE; key += 1) initializeHomeCosts(key);
  for (let mask = 1; mask < 64; mask += 1) POPCOUNT[mask] = POPCOUNT[mask >> 1] + (mask & 1);
  for (let progress = -1; progress <= FINISH; progress += 1) {
    for (let die = 1; die <= 6; die += 1) {
      if (progress === -1 ? die === 6 : progress < FINISH && progress + die <= FINISH) {
        LEGAL_MASKS[progress + 1] |= 1 << (die - 1);
      }
    }
    for (let player = 0; player < 2; player += 1) {
      PHYSICAL[player][progress + 1] = progress >= 0 && progress <= 50
        ? (Engine.START_OFFSETS[player] + progress) % Engine.RING.length : -1;
      const position = Engine.position(player, progress);
      UNSAFE[player][progress + 1] = position.zone === 'ring' && !Engine.isSafeCell(position.cellId) ? 1 : 0;
    }
  }

  function assertPerspective(perspective) {
    if (perspective !== 0 && perspective !== 1) throw new RangeError('Perspective must be player 0 or 1.');
  }

  function assertStreak(streak) {
    if (!Number.isInteger(streak) || streak < 0 || streak > 2) throw new RangeError('Six streak must be 0, 1 or 2.');
  }

  function profileFor(profile) {
    const name = profile === undefined ? 'full' : profile;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PROFILES, name)) {
      throw new RangeError('Evaluation profile must be cost-only, race or full.');
    }
    return PROFILES[name];
  }

  function expectedRolls(progress, streak = 0) {
    if (!Number.isInteger(progress) || progress < -1 || progress > FINISH) throw new RangeError('Invalid token progress.');
    assertStreak(streak);
    return SINGLE_COSTS[streak * WIDTH + progress + 1];
  }

  function expectedHomeRolls(tokens, streak = 0) {
    if (!Array.isArray(tokens) || tokens.length !== 4 || tokens.some(function (p) {
      return !Number.isInteger(p) || p < 50 || p > FINISH;
    })) throw new RangeError('Home race requires four token positions from 50 to 56.');
    assertStreak(streak);
    let key = 0;
    for (let token = 0; token < 4; token += 1) key += (FINISH - tokens[token]) * POWERS[token];
    return HOME_COSTS[streak * HOME_SIZE + key];
  }

  // 捕获机会只枚举 4×4 对距离，不构造引擎后继。每个骰点最多选一个目标格。
  function capturePotential(state, actor) {
    const own = state.tokenProgress[actor];
    const victim = 1 - actor;
    const enemy = state.tokenProgress[victim];
    let m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0, m6 = 0;
    for (let target = 0; target < 4; target += 1) {
      const progress = enemy[target];
      if (!UNSAFE[victim][progress + 1] || enemy.indexOf(progress) !== target) continue;
      let copies = 1;
      for (let other = target + 1; other < 4; other += 1) if (enemy[other] === progress) copies += 1;
      const loss = (SINGLE_COSTS[0] - SINGLE_COSTS[progress + 1]) * copies;
      const targetCell = PHYSICAL[victim][progress + 1];
      for (let token = 0; token < 4; token += 1) {
        const from = own[token];
        if (from < 0 || from > 50) continue;
        const distance = (targetCell - PHYSICAL[actor][from + 1] + Engine.RING.length) % Engine.RING.length;
        if (distance < 1 || distance > 6 || from + distance > 50) continue;
        if (distance === 1) m1 = Math.max(m1, loss);
        else if (distance === 2) m2 = Math.max(m2, loss);
        else if (distance === 3) m3 = Math.max(m3, loss);
        else if (distance === 4) m4 = Math.max(m4, loss);
        else if (distance === 5) m5 = Math.max(m5, loss);
        else m6 = Math.max(m6, loss);
      }
    }
    if (state.activePlayer === actor) {
      if (state.phase === 'awaitingMove') {
        return state.pendingDie === 1 ? m1 : state.pendingDie === 2 ? m2 : state.pendingDie === 3 ? m3
          : state.pendingDie === 4 ? m4 : state.pendingDie === 5 ? m5 : m6;
      }
      if (state.consecutiveSixes === 2) m6 = 0;
    }
    return (m1 + m2 + m3 + m4 + m5 + m6) / 6;
  }

  function valueKnownState(state, perspective, weights, withFeatures) {
    if (state.winner !== null) {
      const terminal = state.winner === perspective ? 1 : -1;
      return withFeatures ? { value: terminal, features: { terminal: true, winner: state.winner, perspective: perspective } } : terminal;
    }
    let race0 = 0, race1 = 0, efficiency0 = 0, efficiency1 = 0, mobility0 = 0, mobility1 = 0;
    for (let player = 0; player < 2; player += 1) {
      const tokens = state.tokenProgress[player];
      const streak = state.phase === 'awaitingRoll' && state.activePlayer === player ? state.consecutiveSixes : 0;
      let cost = 0, homeSum = 0, homeKey = 0, legalMask = 0;
      for (let token = 0; token < 4; token += 1) {
        const progress = tokens[token];
        const single = SINGLE_COSTS[streak * WIDTH + progress + 1];
        cost += single;
        legalMask |= LEGAL_MASKS[progress + 1];
        if (progress >= 50) {
          homeSum += single;
          homeKey += (FINISH - progress) * POWERS[token];
        }
      }
      const efficiency = homeSum - HOME_COSTS[streak * HOME_SIZE + homeKey];
      cost -= weights.completion * efficiency;
      if (streak === 2) legalMask &= 31;
      const mobility = POPCOUNT[legalMask] / 6;
      if (player === 0) { race0 = cost; efficiency0 = efficiency; mobility0 = mobility; }
      else { race1 = cost; efficiency1 = efficiency; mobility1 = mobility; }
    }
    const threat0 = weights.threat || withFeatures
      ? capturePotential(state, 1) * (state.activePlayer === 1 ? 1 : weights.delayedThreat) : 0;
    const threat1 = weights.threat || withFeatures
      ? capturePotential(state, 0) * (state.activePlayer === 0 ? 1 : weights.delayedThreat) : 0;
    const tempo0 = (state.activePlayer === 0 ? 1 : -1) * (state.consecutiveSixes === 2 ? 5 / 6 : 1);
    const z0 = race1 - race0 + weights.mobility * (mobility0 - mobility1)
      - weights.threat * (threat0 - threat1) + weights.tempo * tempo0;
    const z = perspective === 0 ? z0 : -z0;
    // 双曲正切可能浮点饱和；此变换对所有有限值都严格落在 (-0.95, 0.95)。
    const value = 0.95 * z / (weights.scale + Math.abs(z));
    if (!withFeatures) return value;
    return { value: value, features: {
      terminal: false, perspective: perspective, raceCost: [race0, race1],
      completionEfficiency: [efficiency0, efficiency1], mobility: [mobility0, mobility1],
      threatLoss: [threat0, threat1], tempo: perspective === 0 ? tempo0 : -tempo0, z: z
    } };
  }

  function evaluate(state, perspective, profile) {
    Engine.validateState(state);
    assertPerspective(perspective);
    return valueKnownState(state, perspective, profileFor(profile), true);
  }

  function fastValue(state, perspective, profile) {
    return valueKnownState(state, perspective, profile === undefined ? PROFILES.full : profileFor(profile), false);
  }

  return Object.freeze({ VERSION: VERSION, EVALUATION_VERSION: VERSION, PROFILES: PROFILES, expectedRolls: expectedRolls,
    expectedHomeRolls: expectedHomeRolls, evaluate: evaluate, fastValue: fastValue });
}));
