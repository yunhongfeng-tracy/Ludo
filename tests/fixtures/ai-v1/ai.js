(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.LudoAI = factory(root.LudoEngine);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  if (!Engine) throw new Error('LudoAI requires LudoEngine.');

  const STRATEGY_VERSION = 'expectiminimax-policy@2';
  const EVALUATION_VERSION = 'position-mobility-threat@1';
  const SEARCH_VERSION = 'roll-depth-complete-layer-lru@1';
  const RNG_VERSION = 'fnv1a-mulberry32@1';
  const FINISH = 56;
  const WEIGHTS = Object.freeze({ mobility: 0.15, threat: 0.50, scale: 2 });
  const LEVEL_CONFIGS = Object.freeze({
    advanced: Object.freeze({ budgetMs: 150, maxNodes: 12000, maxDepth: 64, maxCacheEntries: 20000 }),
    ultimate: Object.freeze({ budgetMs: 600, maxNodes: 60000, maxDepth: 64, maxCacheEntries: 20000 })
  });

  function positionValue(progress) {
    if (!Number.isInteger(progress) || progress < -1 || progress > FINISH) {
      throw new RangeError('Token progress must be an integer from -1 to 56.');
    }
    if (progress === -1) return -0.15;
    if (progress <= 50) return 0.60 * Math.pow(progress / 50, 1.25);
    if (progress < FINISH) return 0.70 + 0.04 * (progress - 51);
    return 1;
  }

  function assertPerspective(perspective) {
    if (perspective !== 0 && perspective !== 1) {
      throw new RangeError('Perspective must be player 0 or 1.');
    }
  }

  // 棋子编号不影响规则；排序后的双方位置和全部回合字段共同判断等价性。
  function canonicalState(state) {
    return JSON.stringify([
      state.rulesetId, state.rulesetVersion, state.boardVersion,
      state.activePlayer, state.phase, state.pendingDie,
      state.consecutiveSixes, state.winner,
      state.tokenProgress[0].slice().sort(function (a, b) { return a - b; }),
      state.tokenProgress[1].slice().sort(function (a, b) { return a - b; })
    ]);
  }

  function distinctSuccessors(state) {
    const seen = new Set();
    const successors = [];
    const actions = Engine.getLegalActions(state).slice().sort(function (a, b) { return a - b; });
    for (const action of actions) {
      // 基础棋规中，同进度的己方棋子有完全相同的结算后继；编号只用于落子。
      const progress = state.tokenProgress[state.activePlayer][action];
      if (!seen.has(progress)) {
        seen.add(progress);
        successors.push({ action: action, state: Engine.applyAction(state, action) });
      }
    }
    return successors;
  }

  function captureLoss(before, after, victim) {
    let loss = 0;
    let count = 0;
    for (let token = 0; token < 4; token += 1) {
      const progress = before.tokenProgress[victim][token];
      if (progress >= 0 && progress < FINISH && after.tokenProgress[victim][token] === -1) {
        loss += positionValue(progress) - positionValue(-1);
        count += 1;
      }
    }
    return { loss: loss, count: count };
  }

  // 在双方各自开始新回合的投影中枚举下一掷；不预言真实下一回合。
  function projectedMetrics(state, actor) {
    const victim = 1 - actor;
    const own = state.tokenProgress[actor];
    const enemy = state.tokenProgress[victim];
    let successorCount = 0;
    let noActionDice = 0;
    let captureDice = 0;
    let lossSum = 0;
    for (let die = 1; die <= 6; die += 1) {
      let choices = 0;
      let worstLoss = 0;
      for (let token = 0; token < 4; token += 1) {
        const from = own[token];
        if (own.indexOf(from) !== token ||
            (from === -1 ? die !== 6 : from === FINISH || from + die > FINISH)) continue;
        choices += 1;
        const to = from === -1 ? 0 : from + die;
        const target = (Engine.START_OFFSETS[actor] + to) % Engine.RING.length;
        if (to > 50 || Engine.SAFE_INDICES.indexOf(target) !== -1) continue;
        let loss = 0;
        for (let enemyId = 0; enemyId < 4; enemyId += 1) {
          const progress = enemy[enemyId];
          if (progress >= 0 && progress <= 50 &&
              (Engine.START_OFFSETS[victim] + progress) % Engine.RING.length === target) {
            loss += POSITION_VALUES[progress + 1] - POSITION_VALUES[0];
          }
        }
        if (loss > worstLoss) worstLoss = loss;
      }
      successorCount += choices;
      if (choices === 0) noActionDice += 1;
      if (worstLoss > 0) captureDice += 1;
      lossSum += worstLoss;
    }
    return {
      mobility: successorCount / 24,
      noActionProbability: noActionDice / 6,
      victimThreatLoss: lossSum / 6,
      victimCaptureOpportunity: captureDice / 6
    };
  }

  // 位置价值只与整数路程有关；叶节点复用查表，数值与原公式一致。
  const POSITION_VALUES = Object.freeze(Array.from({ length: FINISH + 2 }, function (_, index) {
    return positionValue(index - 1);
  }));

  function evaluate(state, perspective) {
    assertPerspective(perspective);
    Engine.validateState(state);
    return evaluateKnownState(state, perspective, true);
  }

  function evaluateKnownState(state, perspective, withFeatures) {
    if (state.winner === 0 || state.winner === 1) {
      const terminalValue = state.winner === perspective ? 1 : -1;
      if (!withFeatures) return terminalValue;
      return {
        value: terminalValue,
        features: { terminal: true, perspective: perspective, winner: state.winner }
      };
    }

    const position = state.tokenProgress.map(function (tokens) {
      return tokens.reduce(function (total, progress) { return total + POSITION_VALUES[progress + 1]; }, 0);
    });
    const metrics = [projectedMetrics(state, 0), projectedMetrics(state, 1)];
    const mobility = metrics.map(function (metric) { return metric.mobility; });
    const noActionProbability = metrics.map(function (metric) { return metric.noActionProbability; });
    // 指标按承受威胁的一方索引，因此交换进攻方和受害方。
    const threatLoss = [metrics[1].victimThreatLoss, metrics[0].victimThreatLoss];
    const captureOpportunity = [metrics[1].victimCaptureOpportunity, metrics[0].victimCaptureOpportunity];
    const opponent = 1 - perspective;
    const positionDifference = position[perspective] - position[opponent];
    const mobilityDifference = mobility[perspective] - mobility[opponent];
    const threatDifference = threatLoss[perspective] - threatLoss[opponent];
    const z = positionDifference + WEIGHTS.mobility * mobilityDifference - WEIGHTS.threat * threatDifference;
    const value = 0.95 * Math.tanh(z / WEIGHTS.scale);
    if (!withFeatures) return value;
    return {
      value: value,
      features: {
        terminal: false,
        perspective: perspective,
        position: position,
        mobility: mobility,
        noActionProbability: noActionProbability,
        threatLoss: threatLoss,
        captureOpportunity: captureOpportunity,
        positionDifference: positionDifference,
        mobilityDifference: mobilityDifference,
        threatDifference: threatDifference,
        z: z
      }
    };
  }

  function describeAction(before, after, action) {
    const actor = before.activePlayer;
    const from = before.tokenProgress[actor][action];
    const to = after.tokenProgress[actor][action];
    if (after.winner === actor) return '最后一枚棋子到家，赢得本局';
    const captures = captureLoss(before, after, 1 - actor).count;
    if (to === FINISH) return '让一枚棋子到达终点';
    if (captures > 0) return '吃回对方 ' + captures + ' 枚棋子，减少其场上进度';
    if (from === -1) return '让一枚棋子出营，进入公共路线';
    if (from <= 50 && to >= 51) return '进入专属归家通道，避开对方吃子';
    const destination = Engine.position(actor, to);
    const origin = Engine.position(actor, from);
    if (destination.zone === 'ring' && Engine.isSafeCell(destination.cellId)) {
      return Engine.isSafeCell(origin.cellId) ? '推进至安全格' : '进入安全格，当前落点不会被吃';
    }
    if (destination.zone === 'home') return '沿归家通道前进，接近终点';
    return '前进 ' + (to - from) + ' 格';
  }

  function rankSuccessors(state, successors) {
    const perspective = state.activePlayer;
    return successors.map(function (successor) {
      const result = evaluate(successor.state, perspective);
      return {
        action: successor.action,
        score: result.value,
        features: result.features,
        reason: describeAction(state, successor.state, successor.action)
      };
    }).sort(function (a, b) {
      return b.score - a.score || a.action - b.action;
    });
  }

  function rankActions(state) {
    return rankSuccessors(state, distinctSuccessors(state));
  }

  function monotonicNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now() : Date.now();
  }

  function searchOptions(level, options) {
    const defaults = LEVEL_CONFIGS[level];
    const supplied = options === undefined ? {} : options;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
      throw new TypeError('Search options must be an object.');
    }
    const config = {};
    for (const name of ['budgetMs', 'maxNodes', 'maxDepth', 'maxCacheEntries']) {
      const value = supplied[name] === undefined ? defaults[name] : supplied[name];
      const infiniteAllowed = name === 'budgetMs' || name === 'maxNodes';
      if (!(infiniteAllowed && value === Infinity) &&
          (!Number.isFinite(value) || value < 0 || (name !== 'budgetMs' && !Number.isInteger(value)))) {
        throw new RangeError(name + ' must be a non-negative ' + (name === 'budgetMs' ? 'number.' : 'integer.'));
      }
      config[name] = value;
    }
    return config;
  }

  // 每次决策独立缓存，确保同一快照和节点额度可复现，不受上一局缓存影响。
  function searchSuccessors(state, successors, ranked, config, diagnostics, started) {
    const perspective = state.activePlayer;
    const cache = new Map();
    const namespace = EVALUATION_VERSION + '|' + SEARCH_VERSION + '|' + perspective + '|';
    const deadline = started + config.budgetMs;
    const interrupted = {};
    let best = ranked[0];
    let ordered = ranked.slice();
    const successorByAction = new Map(successors.map(function (successor) { return [successor.action, successor.state]; }));
    diagnostics.rootScores = ordered.map(function (entry) { return { action: entry.action, score: entry.score }; });

    function visit(next, remaining) {
      if (diagnostics.visitedNodes >= config.maxNodes) {
        diagnostics.stopReason = 'node-budget';
        throw interrupted;
      }
      // 小批量检查单调时钟；额度统计包括缓存命中，不包括中级备用评分。
      if ((diagnostics.visitedNodes & 31) === 0 && monotonicNow() >= deadline) {
        diagnostics.stopReason = 'time-budget';
        throw interrupted;
      }
      diagnostics.visitedNodes += 1;
      const key = config.maxCacheEntries > 0 ? namespace + remaining + '|' + canonicalState(next) : null;
      if (key !== null && cache.has(key)) {
        const cached = cache.get(key);
        cache.delete(key);
        cache.set(key, cached);
        diagnostics.cacheHits += 1;
        return cached;
      }

      let value;
      if (next.winner !== null || remaining === 0) {
        diagnostics.leafEvaluations += 1;
        value = evaluateKnownState(next, perspective, false);
      } else {
        let sum = 0;
        for (let die = 1; die <= 6; die += 1) {
          const rolled = Engine.applyRoll(next, die);
          let branchValue;
          if (rolled.phase !== 'awaitingMove') {
            // 三连 6 或无动作已经由引擎完整结算，仍占一次未来掷骰深度。
            branchValue = visit(rolled, remaining - 1);
          } else {
            const maximize = rolled.activePlayer === perspective;
            branchValue = maximize ? -Infinity : Infinity;
            for (const child of distinctSuccessors(rolled)) {
              const childValue = visit(child.state, remaining - 1);
              branchValue = maximize ? Math.max(branchValue, childValue) : Math.min(branchValue, childValue);
            }
          }
          sum += branchValue / 6;
        }
        value = sum;
      }
      // 只有完整算完的子树可以入表，机会节点不能保存部分骰点的平均值。
      if (key !== null) {
        if (cache.size >= config.maxCacheEntries) cache.delete(cache.keys().next().value);
        cache.set(key, value);
      }
      return value;
    }

    diagnostics.stopReason = 'max-depth';
    for (let depth = 1; depth <= config.maxDepth; depth += 1) {
      diagnostics.attemptedDepth = depth;
      const layer = [];
      try {
        for (const previous of ordered) {
          const next = successorByAction.get(previous.action);
          layer.push({ action: previous.action, score: visit(next, depth), reason: previous.reason });
        }
      } catch (error) {
        if (error !== interrupted) throw error;
        break;
      }
      // 所有根动作完整完成同一深度之后才提交；未完成层不能改变最终动作或分数。
      layer.sort(function (a, b) { return b.score - a.score || a.action - b.action; });
      ordered = layer;
      best = layer[0];
      diagnostics.completedDepth = depth;
      diagnostics.rootScores = layer.map(function (entry) { return { action: entry.action, score: entry.score }; });
    }
    diagnostics.cacheEntries = cache.size;
    if (diagnostics.completedDepth > 0) {
      return {
        action: best.action,
        score: best.score,
        reason: '预判 ' + diagnostics.completedDepth + ' 次后续掷骰：' + best.reason
      };
    }
    return best;
  }

  function chooseAction(state, difficulty, rng, options) {
    const level = difficulty === undefined ? 'medium' : difficulty;
    if (level !== 'beginner' && level !== 'medium' && !Object.prototype.hasOwnProperty.call(LEVEL_CONFIGS, level)) {
      throw new RangeError('Difficulty must be beginner, medium, advanced or ultimate.');
    }
    const started = monotonicNow();
    const config = Object.prototype.hasOwnProperty.call(LEVEL_CONFIGS, level) ? searchOptions(level, options) : null;
    const successors = distinctSuccessors(state);
    const diagnostics = {
      strategyVersion: STRATEGY_VERSION,
      evaluationVersion: EVALUATION_VERSION,
      difficulty: level,
      legalActions: Engine.getLegalActions(state).length,
      uniqueSuccessors: successors.length,
      completedDepth: 0,
      attemptedDepth: 0,
      evaluatedSuccessors: 0,
      visitedNodes: 0,
      leafEvaluations: 0,
      cacheHits: 0,
      cacheEntries: 0,
      elapsedMs: 0,
      stopReason: 'completed'
    };
    if (config) Object.assign(diagnostics, config, { searchVersion: SEARCH_VERSION, rootScores: [] });
    let chosen;
    if (successors.length === 0) {
      diagnostics.stopReason = 'no-legal-actions';
      chosen = { action: null, score: null, reason: '当前没有合法走法' };
    } else {
      const winning = successors.find(function (successor) {
        return successor.state.winner === state.activePlayer;
      });
      if (winning) {
        diagnostics.stopReason = 'immediate-win';
        chosen = { action: winning.action, score: 1, reason: describeAction(state, winning.state, winning.action) };
      } else if (successors.length === 1) {
        diagnostics.stopReason = 'only-distinct-successor';
        chosen = {
          action: successors[0].action,
          score: null,
          reason: '唯一有效走法：' + describeAction(state, successors[0].state, successors[0].action)
        };
      } else if (level === 'beginner') {
        const random = rng === undefined ? Math.random : rng;
        if (typeof random !== 'function') throw new TypeError('rng must be a function.');
        // 只有一个后继时不消耗策略随机数，也无需计算局面评分。
        let index = 0;
        if (successors.length > 1) {
          const sample = random();
          if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
            throw new RangeError('rng must return a number in [0, 1).');
          }
          index = Math.floor(sample * successors.length);
        }
        const successor = successors[index];
        chosen = {
          action: successor.action,
          score: null,
          reason: '初级随机走法：' + describeAction(state, successor.state, successor.action)
        };
      } else {
        const ranked = rankSuccessors(state, successors);
        diagnostics.evaluatedSuccessors = ranked.length;
        chosen = config ? searchSuccessors(state, successors, ranked, config, diagnostics, started) : ranked[0];
      }
    }
    diagnostics.elapsedMs = monotonicNow() - started;
    return { action: chosen.action, score: chosen.score, reason: chosen.reason, diagnostics: diagnostics };
  }

  // 独立且可复现的策略/测试随机流。不得传入真实骰子的随机源或其种子。
  function createSeededRng(seed) {
    if (typeof seed !== 'number' && typeof seed !== 'string') {
      throw new TypeError('Seed must be a finite number or a string.');
    }
    if (typeof seed === 'number' && !Number.isFinite(seed)) {
      throw new RangeError('Numeric seed must be finite.');
    }
    const input = typeof seed + ':' + String(seed);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
    }
    let state = hash >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      let value = Math.imul(state ^ (state >>> 15), state | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  return Object.freeze({
    STRATEGY_VERSION: STRATEGY_VERSION,
    EVALUATION_VERSION: EVALUATION_VERSION,
    SEARCH_VERSION: SEARCH_VERSION,
    LEVEL_CONFIGS: LEVEL_CONFIGS,
    RNG_VERSION: RNG_VERSION,
    WEIGHTS: WEIGHTS,
    positionValue: positionValue,
    evaluate: evaluate,
    rankActions: rankActions,
    chooseAction: chooseAction,
    createSeededRng: createSeededRng
  });
}));
