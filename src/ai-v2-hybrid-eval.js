(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'), require('./ai.js'), require('./ai-v2-eval.js'));
  } else root.LudoV2HybridEval = factory(root.LudoEngine, root.LudoAI, root.LudoV2Eval);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine, Classic, V2) {
  'use strict';

  if (!Engine || !Classic || !V2) throw new Error('LudoV2HybridEval requires Engine, Classic AI and V2Eval.');
  const VERSION = 'classic-home-efficiency-turn-threat@1';
  const PROFILES = Object.freeze({
    classic: Object.freeze({ homeEfficiency: 0, actualThreat: false, delayedThreat: 0.55 }),
    full: Object.freeze({ homeEfficiency: 0.03, actualThreat: true, delayedThreat: 0.55 })
  });
  const POSITIONS = new Float64Array(58);
  const MOBILITY = new Uint8Array(58);
  const PHYSICAL = [new Int8Array(58), new Int8Array(58)];
  const UNSAFE = [new Uint8Array(58), new Uint8Array(58)];
  const HOME_EFFICIENCY = new Float64Array(2401);
  const POWERS = [1, 7, 49, 343];

  for (let progress = -1; progress <= Engine.FINISH; progress += 1) {
    POSITIONS[progress + 1] = Classic.positionValue(progress);
    MOBILITY[progress + 1] = progress === -1 ? 1 : Math.min(6, Engine.FINISH - progress);
    for (let player = 0; player < 2; player += 1) {
      const point = Engine.position(player, progress);
      PHYSICAL[player][progress + 1] = point.zone === 'ring'
        ? (Engine.START_OFFSETS[player] + progress) % Engine.RING.length : -1;
      UNSAFE[player][progress + 1] = point.zone === 'ring' && !Engine.isSafeCell(point.cellId) ? 1 : 0;
    }
  }
  for (let key = 0; key < HOME_EFFICIENCY.length; key += 1) {
    let encoded = key;
    const tokens = [];
    let singleSum = 0;
    for (let token = 0; token < 4; token += 1) {
      const progress = Engine.FINISH - encoded % 7;
      tokens.push(progress);
      singleSum += V2.expectedRolls(progress);
      encoded = Math.floor(encoded / 7);
    }
    // 无对手干扰的归家子问题，不能解释为整局精确剩余时间。
    HOME_EFFICIENCY[key] = singleSum - V2.expectedHomeRolls(tokens);
  }

  function profileFor(profile) {
    const name = profile === undefined ? 'full' : profile;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PROFILES, name)) {
      throw new RangeError('Hybrid profile must be classic or full.');
    }
    return PROFILES[name];
  }

  function threats(state, actor, profile) {
    const own = state.tokenProgress[actor];
    const victim = 1 - actor;
    const enemy = state.tokenProgress[victim];
    let m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0, m6 = 0;
    for (let target = 0; target < 4; target += 1) {
      const progress = enemy[target];
      if (!UNSAFE[victim][progress + 1] || enemy.indexOf(progress) !== target) continue;
      let copies = 1;
      for (let other = target + 1; other < 4; other += 1) if (enemy[other] === progress) copies += 1;
      const loss = (POSITIONS[progress + 1] - POSITIONS[0]) * copies;
      for (let token = 0; token < 4; token += 1) {
        const from = own[token];
        if (from < 0 || from > 50) continue;
        const distance = (PHYSICAL[victim][progress + 1] - PHYSICAL[actor][from + 1] + Engine.RING.length) % Engine.RING.length;
        if (distance < 1 || distance > 6 || from + distance > 50) continue;
        if (distance === 1) m1 = Math.max(m1, loss);
        else if (distance === 2) m2 = Math.max(m2, loss);
        else if (distance === 3) m3 = Math.max(m3, loss);
        else if (distance === 4) m4 = Math.max(m4, loss);
        else if (distance === 5) m5 = Math.max(m5, loss);
        else m6 = Math.max(m6, loss);
      }
    }
    const fresh = (m1 + m2 + m3 + m4 + m5 + m6) / 6;
    let actual = fresh;
    if (profile.actualThreat) {
      if (state.activePlayer === actor) {
        if (state.phase === 'awaitingMove') {
          actual = state.pendingDie === 1 ? m1 : state.pendingDie === 2 ? m2 : state.pendingDie === 3 ? m3
            : state.pendingDie === 4 ? m4 : state.pendingDie === 5 ? m5 : m6;
        } else if (state.consecutiveSixes === 2) actual -= m6 / 6;
      } else actual *= profile.delayedThreat;
    }
    return { fresh: fresh, actual: actual };
  }

  function valueKnownState(state, perspective, profile, withFeatures) {
    if (state.winner !== null) {
      const value = state.winner === perspective ? 1 : -1;
      return withFeatures ? { value: value, features: { terminal: true, perspective: perspective, winner: state.winner } } : value;
    }
    let position0 = 0, position1 = 0, mobility0 = 0, mobility1 = 0, efficiency0 = 0, efficiency1 = 0;
    for (let player = 0; player < 2; player += 1) {
      const tokens = state.tokenProgress[player];
      let position = 0, mobility = 0, homeKey = 0;
      for (let token = 0; token < 4; token += 1) {
        const progress = tokens[token];
        position += POSITIONS[progress + 1];
        if (tokens.indexOf(progress) === token) mobility += MOBILITY[progress + 1];
        if (progress >= 50) homeKey += (Engine.FINISH - progress) * POWERS[token];
      }
      const efficiency = HOME_EFFICIENCY[homeKey];
      if (player === 0) { position0 = position; mobility0 = mobility / 24; efficiency0 = efficiency; }
      else { position1 = position; mobility1 = mobility / 24; efficiency1 = efficiency; }
    }
    const threat0 = threats(state, 1, profile);
    const threat1 = threats(state, 0, profile);
    const homeCorrection0 = profile.homeEfficiency * (efficiency0 - efficiency1);
    const classicZ0 = position0 - position1 + Classic.WEIGHTS.mobility * (mobility0 - mobility1)
      - Classic.WEIGHTS.threat * (threat0.fresh - threat1.fresh);
    const turnCorrection0 = Classic.WEIGHTS.threat *
      ((threat0.fresh - threat1.fresh) - (threat0.actual - threat1.actual));
    const z0 = classicZ0 + turnCorrection0 + homeCorrection0;
    const z = perspective === 0 ? z0 : -z0;
    const value = 0.95 * Math.tanh(z / Classic.WEIGHTS.scale);
    if (!withFeatures) return value;
    return { value: value, features: {
      terminal: false, perspective: perspective, position: [position0, position1], mobility: [mobility0, mobility1],
      threatLoss: [threat0.actual, threat1.actual], freshThreatLoss: [threat0.fresh, threat1.fresh],
      completionEfficiency: [efficiency0, efficiency1], classicZ: perspective === 0 ? classicZ0 : -classicZ0,
      homeCorrection: perspective === 0 ? homeCorrection0 : -homeCorrection0,
      turnCorrection: perspective === 0 ? turnCorrection0 : -turnCorrection0, z: z
    } };
  }

  function evaluate(state, perspective, profile) {
    Engine.validateState(state);
    if (perspective !== 0 && perspective !== 1) throw new RangeError('Perspective must be 0 or 1.');
    return valueKnownState(state, perspective, profileFor(profile), true);
  }

  function fastValue(state, perspective, profile) {
    return valueKnownState(state, perspective, profile === undefined ? PROFILES.full : profileFor(profile), false);
  }

  return Object.freeze({ version: VERSION, VERSION: VERSION, EVALUATION_VERSION: VERSION,
    PROFILES: PROFILES, evaluate: evaluate, fastValue: fastValue });
}));
