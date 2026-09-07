/* 专属归家通道残局：有限状态概率方程，数值求解到浮点精度。 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.LudoV2Endgame = factory(root.LudoEngine);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  const STRATEGY_VERSION = 'home-lane-exact-dynamic-programming@1';
  const DEFAULT_CONFIG = Object.freeze({ budgetMs: 600, maxStates: 24000 });
  const FLOAT_TOLERANCE = 1e-10;

  function now() { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
  function configOptions(options) {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new TypeError('Endgame options must be an object.');
    const config = { ...DEFAULT_CONFIG, ...options };
    if (!(config.budgetMs === Infinity || Number.isFinite(config.budgetMs) && config.budgetMs >= 0)) throw new RangeError('budgetMs must be nonnegative or Infinity.');
    if (!Number.isSafeInteger(config.maxStates) || config.maxStates < 0) throw new RangeError('maxStates must be a finite nonnegative integer.');
    return config;
  }
  function canSolve(state) {
    Engine.validateState(state);
    return state.tokenProgress.every(function (tokens) { return tokens.every(function (progress) { return progress >= 51; }); });
  }
  function boardKey(state) {
    return state.tokenProgress.map(function (tokens) { return tokens.slice().sort(function (a, b) { return a - b; }).join(','); }).join('|');
  }
  function remainingDistance(state) { return state.tokenProgress.reduce(function (sum, tokens) { return sum + tokens.reduce(function (subtotal, progress) { return subtotal + Engine.FINISH - progress; }, 0); }, 0); }
  function turnIndex(state) { return state.activePlayer * 3 + state.consecutiveSixes; }

  // 解 (I-Q)V=b；Q 只包含同一位置组合内的换人、连 6 和无动作转移。
  function solveLinear(coefficients, constants) {
    const size = constants.length;
    const matrix = coefficients.map(function (row, index) { return row.concat(constants[index]); });
    for (let column = 0; column < size; column += 1) {
      let pivot = column;
      for (let row = column + 1; row < size; row += 1) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
      if (Math.abs(matrix[pivot][column]) < 1e-14) throw new Error('Endgame transition equations are singular.');
      const swap = matrix[column]; matrix[column] = matrix[pivot]; matrix[pivot] = swap;
      const divisor = matrix[column][column];
      for (let entry = column; entry <= size; entry += 1) matrix[column][entry] /= divisor;
      for (let row = 0; row < size; row += 1) if (row !== column) {
        const multiplier = matrix[row][column];
        for (let entry = column; entry <= size; entry += 1) matrix[row][entry] -= multiplier * matrix[column][entry];
      }
    }
    return matrix.map(function (row) { return row[size]; });
  }

  function makeSolver(state, perspective, options) {
    if (perspective !== 0 && perspective !== 1) throw new RangeError('Perspective must be player 0 or 1.');
    const config = configOptions(options), started = now(), deadline = started + config.budgetMs;
    const memo = new Map(), interrupted = {};
    const diagnostics = { strategyVersion: STRATEGY_VERSION, budgetMs: config.budgetMs, maxStates: config.maxStates, visitedNodes: 0, expandedStates: 0, solvedStates: 0, cachedBoards: 0, cacheHits: 0, transitions: 0, linearSystems: 0, maxEquationResidual: 0, complete: false, exact: false, stopReason: 'not-applicable', elapsedMs: 0 };
    function checkBudget() {
      if (now() >= deadline) { diagnostics.stopReason = 'time-budget'; throw interrupted; }
    }
    function probability(next) {
      diagnostics.visitedNodes += 1;
      checkBudget();
      if (next.phase === 'finished') return next.winner === perspective ? 1 : 0;
      if (next.phase !== 'awaitingRoll') throw new Error('Endgame recursion must begin before a roll.');
      const key = boardKey(next);
      if (memo.has(key)) { diagnostics.cacheHits += 1; return memo.get(key)[turnIndex(next)]; }
      if (diagnostics.expandedStates + 6 > config.maxStates) { diagnostics.stopReason = 'state-budget'; throw interrupted; }
      diagnostics.expandedStates += 6;
      const distance = remainingDistance(next);
      const coefficients = Array.from({ length: 6 }, function (_, row) { return Array.from({ length: 6 }, function (__, column) { return row === column ? 1 : 0; }); });
      const constants = Array(6).fill(0);
      // 非 6 骰点的引擎后继会清空连 6 计数，可以按同一 rolled state 复用局部选招结果。
      const moveValues = new Map();
      for (let player = 0; player < 2; player += 1) for (let streak = 0; streak < 3; streak += 1) {
        const index = player * 3 + streak;
        const before = Engine.cloneState(next);
        before.activePlayer = player; before.consecutiveSixes = streak;
        for (let die = 1; die <= 6; die += 1) {
          checkBudget();
          const rolled = Engine.applyRoll(before, die); diagnostics.transitions += 1;
          if (rolled.phase === 'awaitingMove') {
            const rolledKey = Engine.stateKey(rolled, { canonicalTokens: true });
            let value = moveValues.get(rolledKey);
            if (value === undefined) {
              value = player === perspective ? -Infinity : Infinity;
              const seen = new Set();
              for (const action of Engine.getLegalActions(rolled)) {
                const child = Engine.applyAction(rolled, action), childKey = boardKey(child);
                if (seen.has(childKey)) continue;
                seen.add(childKey);
                // 适用范围内任何走子都严格减少剩余距离，不可能形成跨位置环。
                if (remainingDistance(child) >= distance) throw new Error('Endgame move did not strictly reduce remaining distance.');
                const childValue = probability(child);
                value = player === perspective ? Math.max(value, childValue) : Math.min(value, childValue);
              }
              moveValues.set(rolledKey, value);
            }
            constants[index] += value / 6;
          } else if (rolled.phase === 'finished') constants[index] += (rolled.winner === perspective ? 1 : 0) / 6;
          else {
            if (boardKey(rolled) !== key) throw new Error('Unexpected endgame no-action board change.');
            coefficients[index][turnIndex(rolled)] -= 1 / 6;
          }
        }
      }
      const values = solveLinear(coefficients, constants);
      for (let row = 0; row < 6; row += 1) {
        const residual = Math.abs(coefficients[row].reduce(function (sum, coefficient, column) { return sum + coefficient * values[column]; }, 0) - constants[row]);
        diagnostics.maxEquationResidual = Math.max(diagnostics.maxEquationResidual, residual);
        if (residual > FLOAT_TOLERANCE || values[row] < -FLOAT_TOLERANCE || values[row] > 1 + FLOAT_TOLERANCE) throw new Error('Endgame numerical residual exceeded tolerance.');
        values[row] = Math.max(0, Math.min(1, values[row]));
      }
      checkBudget();
      diagnostics.linearSystems += 1; diagnostics.solvedStates += 6;
      memo.set(key, values); diagnostics.cachedBoards = memo.size;
      return values[turnIndex(next)];
    }
    function finish(complete) {
      diagnostics.complete = complete; diagnostics.exact = complete;
      if (complete) diagnostics.stopReason = 'exact-solved';
      diagnostics.elapsedMs = now() - started;
      return diagnostics;
    }
    return { probability, finish, diagnostics, interrupted };
  }

  function solveState(state, perspective, options) {
    const applicable = canSolve(state), solver = makeSolver(state, perspective, options);
    if (!applicable) return { applicable: false, complete: false, probability: null, diagnostics: solver.finish(false) };
    if (state.phase === 'awaitingMove') throw new Error('solveState expects awaitingRoll or finished; use analyze to compare root moves.');
    try {
      const probability = solver.probability(state);
      return { applicable: true, complete: true, probability, diagnostics: solver.finish(true) };
    } catch (error) {
      if (error !== solver.interrupted) throw error;
      return { applicable: true, complete: false, probability: null, diagnostics: solver.finish(false) };
    }
  }
  function analyze(state, options) {
    const applicable = canSolve(state), solver = makeSolver(state, state.activePlayer, options);
    if (!applicable || state.phase !== 'awaitingMove') {
      if (applicable) solver.diagnostics.stopReason = 'no-root-action';
      return { applicable, complete: false, action: null, score: null, probability: null, diagnostics: solver.finish(false) };
    }
    const candidates = [], seen = new Set();
    try {
      for (const action of Engine.getLegalActions(state)) {
        const child = Engine.applyAction(state, action), key = boardKey(child);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ action, probability: solver.probability(child) });
      }
      candidates.sort(function (a, b) { return b.probability - a.probability || a.action - b.action; });
      const chosen = candidates[0], diagnostics = solver.finish(true);
      diagnostics.rootProbabilities = candidates;
      return { applicable: true, complete: true, action: chosen.action, score: chosen.probability, probability: chosen.probability, reason: '归家通道残局完整求解，选择最优获胜概率', diagnostics };
    } catch (error) {
      if (error !== solver.interrupted) throw error;
      // 任何候选未解完时，不暴露已完成候选评分供外部误用为最终选择。
      return { applicable: true, complete: false, action: null, score: null, probability: null, diagnostics: solver.finish(false) };
    }
  }
  function chooseAction(state, rng, options) {
    const result = analyze(state, options);
    return result.complete ? result : null;
  }
  return Object.freeze({ STRATEGY_VERSION, DEFAULT_CONFIG, FLOAT_TOLERANCE, canSolve, solveState, analyze, chooseAction });
}));
