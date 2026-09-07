(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'), require('./ai-v2-eval.js'));
  } else {
    root.LudoV2Rollout = factory(root.LudoEngine, root.LudoV2Eval);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine, Evaluation) {
  'use strict';

  if (!Engine || !Evaluation) throw new Error('LudoV2Rollout requires Engine and V2Eval.');

  const STRATEGY_VERSION = 'paired-policy-rollout@1';
  const POLICY_VERSION = 'greedy-v2-evaluation-no-exploration@1';
  const RNG_VERSION = 'round-mulberry32-rejection-die@1';
  const CONFIG = Object.freeze({
    budgetMs: 600, maxRounds: 64, maxRolloutSteps: 128, maxNodes: 120000, priorWeight: 4
  });

  function now() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now() : Date.now();
  }

  function readOptions(options) {
    const supplied = options === undefined ? {} : options;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
      throw new TypeError('Rollout options must be an object.');
    }
    const config = {};
    for (const name of Object.keys(CONFIG)) {
      const value = supplied[name] === undefined ? CONFIG[name] : supplied[name];
      const infiniteAllowed = name === 'budgetMs' || name === 'maxNodes';
      const fractionalAllowed = name === 'budgetMs' || name === 'priorWeight';
      if (!(infiniteAllowed && value === Infinity) && (!Number.isFinite(value) || value < 0 ||
          (!fractionalAllowed && !Number.isInteger(value)))) {
        throw new RangeError(name + ' must be a non-negative ' +
          (fractionalAllowed ? 'number.' : 'integer.'));
      }
      config[name] = value;
    }
    return config;
  }

  // 同进度棋子在当前基础棋规下产生相同后继；规则结算始终调用唯一的 Engine。
  function uniqueActions(state) {
    const seen = new Set();
    return Engine.getLegalActions(state).filter(function (action) {
      const progress = state.tokenProgress[state.activePlayer][action];
      if (seen.has(progress)) return false;
      seen.add(progress);
      return true;
    }).sort(function (a, b) {
      // 同分时按棋子路程破平，交换棋子编号不会改变模拟策略。
      return state.tokenProgress[state.activePlayer][a] - state.tokenProgress[state.activePlayer][b] || a - b;
    });
  }

  function roundSeed(random) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new RangeError('rng must return a number in [0, 1).');
    }
    return Math.floor(sample * 4294967296) >>> 0;
  }

  // 每个候选从同一个模拟种子开始，骰流按模拟掷骰顺序推进，不访问真实骰源。
  function simulatedDice(seed) {
    let state = seed >>> 0;
    return function () {
      let value;
      do {
        state = (state + 0x6D2B79F5) >>> 0;
        value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        value = (value ^ (value >>> 14)) >>> 0;
      } while (value >= 4294967292);
      return 1 + value % 6;
    };
  }

  function chooseAction(state, rng, options) {
    const started = now();
    const config = readOptions(options);
    const random = rng === undefined ? Math.random : rng;
    if (typeof random !== 'function') throw new TypeError('rng must be a function.');
    Engine.validateState(state);
    const perspective = state.activePlayer;
    const actions = uniqueActions(state);
    const diagnostics = {
      strategyVersion: STRATEGY_VERSION,
      evaluationVersion: Evaluation.EVALUATION_VERSION,
      policyVersion: POLICY_VERSION,
      rngVersion: RNG_VERSION,
      ...config,
      legalActions: Engine.getLegalActions(state).length,
      uniqueSuccessors: actions.length,
      preparationNodes: 0,
      visitedNodes: 0,
      completedRounds: 0,
      attemptedRounds: 0,
      terminalRollouts: 0,
      truncatedRollouts: 0,
      discardedRollouts: 0,
      incompleteRollouts: 0,
      rootScores: [],
      elapsedMs: 0,
      stopReason: 'max-rounds',
      scoreKind: 'estimated-value'
    };

    function result(action, score, reason) {
      diagnostics.elapsedMs = now() - started;
      return { action: action, score: score, reason: reason, diagnostics: diagnostics };
    }

    if (actions.length === 0) {
      diagnostics.stopReason = 'no-legal-actions';
      return result(null, null, '当前没有合法走法');
    }

    // 有界的根准备先建立合法备用，时间预算包括准备耗时；模拟节点额度单独统计。
    const roots = actions.map(function (action) {
      const after = Engine.applyAction(state, action);
      diagnostics.preparationNodes += 1;
      return { action: action, state: after, staticValue: Evaluation.fastValue(after, perspective),
        sum: 0, samples: 0, wins: 0, losses: 0, truncations: 0 };
    });
    const winning = roots.find(function (root) { return root.state.winner === perspective; });
    if (winning) {
      diagnostics.stopReason = 'immediate-win';
      return result(winning.action, 1, '最后一枚棋子到家，赢得本局');
    }
    if (roots.length === 1) {
      diagnostics.stopReason = 'only-distinct-successor';
      return result(roots[0].action, roots[0].staticValue, '唯一有效走法');
    }

    let best = roots.reduce(function (previous, root) {
      return root.staticValue > previous.staticValue ? root : previous;
    });
    let bestScore = best.staticValue;
    const interrupted = {};
    const deadline = started + config.budgetMs;

    function checkBudget() {
      if (diagnostics.visitedNodes >= config.maxNodes) {
        diagnostics.stopReason = 'node-budget';
        throw interrupted;
      }
      if (now() >= deadline) {
        diagnostics.stopReason = 'time-budget';
        throw interrupted;
      }
    }

    function advanceRoll(position, die) {
      checkBudget();
      diagnostics.visitedNodes += 1;
      return Engine.applyRoll(position, die);
    }

    function advanceAction(position, action) {
      checkBudget();
      diagnostics.visitedNodes += 1;
      return Engine.applyAction(position, action);
    }

    function policyMove(position) {
      const actor = position.activePlayer;
      let preferred = null;
      let value = -Infinity;
      for (const action of uniqueActions(position)) {
        const after = advanceAction(position, action);
        if (after.winner === actor) return after;
        const score = Evaluation.fastValue(after, actor);
        if (score > value) {
          preferred = after;
          value = score;
        }
      }
      return preferred;
    }

    function rollout(initial, seed) {
      const die = simulatedDice(seed);
      let position = initial;
      // 步数按未来掷骰计；每次掷骰的合法落子结算完成后才允许截断。
      for (let step = 0; step < config.maxRolloutSteps && position.winner === null; step += 1) {
        position = advanceRoll(position, die());
        if (position.phase === 'awaitingMove') position = policyMove(position);
      }
      return position.winner === null
        ? { value: Evaluation.fastValue(position, perspective), winner: null }
        : { value: position.winner === perspective ? 1 : -1, winner: position.winner };
    }

    function committedScores() {
      diagnostics.rootScores = roots.map(function (root) {
        const score = root.samples === 0 ? root.staticValue :
          (root.sum + config.priorWeight * root.staticValue) / (root.samples + config.priorWeight);
        return { action: root.action, score: score, staticValue: root.staticValue,
          samples: root.samples, sampleMean: root.samples ? root.sum / root.samples : null,
          wins: root.wins, losses: root.losses, truncations: root.truncations };
      });
    }

    committedScores();
    for (let round = 0; round < config.maxRounds; round += 1) {
      const completed = [];
      let rolloutStarted = false;
      diagnostics.attemptedRounds += 1;
      try {
        checkBudget();
        const seed = roundSeed(random);
        for (const root of roots) {
          rolloutStarted = true;
          completed.push(rollout(root.state, seed));
          rolloutStarted = false;
        }
      } catch (error) {
        if (error !== interrupted) throw error;
        diagnostics.discardedRollouts += completed.length;
        if (rolloutStarted) diagnostics.incompleteRollouts += 1;
        break;
      }
      // 所有根候选都完成本轮才提交。任何半轮的分数和终局统计均不得污染选择。
      roots.forEach(function (root, index) {
        const sample = completed[index];
        root.samples += 1;
        root.sum += sample.value;
        if (sample.winner === null) {
          root.truncations += 1;
          diagnostics.truncatedRollouts += 1;
        } else {
          diagnostics.terminalRollouts += 1;
          if (sample.winner === perspective) root.wins += 1;
          else root.losses += 1;
        }
      });
      diagnostics.completedRounds += 1;
      committedScores();
      const choice = diagnostics.rootScores.reduce(function (previous, root) {
        return root.score > previous.score ||
          (root.score === previous.score && root.staticValue > previous.staticValue) ? root : previous;
      });
      best = roots.find(function (root) { return root.action === choice.action; });
      bestScore = choice.score;
    }

    return result(best.action, bestScore, diagnostics.completedRounds > 0
      ? '比较 ' + diagnostics.completedRounds + ' 轮配对模拟的估计价值'
      : '使用完整的静态局面评分备用走法');
  }

  return Object.freeze({ STRATEGY_VERSION: STRATEGY_VERSION, POLICY_VERSION: POLICY_VERSION,
    RNG_VERSION: RNG_VERSION, CONFIG: CONFIG, DEFAULT_CONFIG: CONFIG, chooseAction: chooseAction });
}));
