/* 终极开发候选：窄范围精确残局与常规搜索共享单次总预算。 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'), require('./ai.js'), require('./ai-v2-search.js'), require('./ai-v2-hybrid-search.js'), require('./ai-v2-endgame.js'));
  } else root.LudoV2Combined = factory(root.LudoEngine, root.LudoAI, root.LudoV2Search, root.LudoV2HybridSearch, root.LudoV2Endgame);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine, Classic, Completion, Hybrid, Endgame) {
  'use strict';
  if (!Engine || !Classic || !Completion || !Hybrid || !Endgame) throw new Error('LudoV2Combined requires the engine, three search profiles and endgame solver.');
  const STRATEGY_VERSION = 'shared-budget-exact-home-and-search@1';
  const EVALUATION_VERSION = 'profiled-search-with-exact-home-probability@1';
  const DEFAULT_CONFIG = Object.freeze({ searchProfile: 'completion', budgetMs: 600, maxNodes: 60000, maxDepth: 64, maxCacheEntries: 20000, endgameBudgetMs: 120, maxEndgameStates: 24000 });
  const SEARCH_PROFILES = Object.freeze(['completion', 'hybrid', 'classic']);

  function now() { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
  function optionsConfig(options) {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new TypeError('Combined options must be an object.');
    for (const key of Object.keys(options || {})) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new RangeError('Unknown combined option: ' + key);
    const config = { ...DEFAULT_CONFIG, ...options };
    if (!SEARCH_PROFILES.includes(config.searchProfile)) throw new RangeError('searchProfile must be completion, hybrid or classic.');
    for (const key of ['budgetMs', 'endgameBudgetMs']) if (!(config[key] === Infinity || Number.isFinite(config[key]) && config[key] >= 0)) throw new RangeError(key + ' must be nonnegative or Infinity.');
    for (const key of ['maxNodes', 'maxDepth', 'maxCacheEntries', 'maxEndgameStates']) {
      if (key === 'maxNodes' && config[key] === Infinity) continue;
      if (!Number.isSafeInteger(config[key]) || config[key] < 0) throw new RangeError(key + ' must be a finite nonnegative integer.');
    }
    return config;
  }
  function chooseAction(state, rng, options) {
    const started = now(), config = optionsConfig(options);
    Engine.validateState(state);
    if (rng !== undefined && typeof rng !== 'function') throw new TypeError('rng must be a function when supplied.');
    const legal = Engine.getLegalActions(state);
    const remaining = function () { return config.budgetMs === Infinity ? Infinity : Math.max(0, config.budgetMs - (now() - started)); };
    const endgame = { applicable: false, attempted: false, complete: false, exact: false, budgetMs: 0, elapsedMs: 0, stopReason: 'not-applicable' };
    const search = { attempted: false, budgetMs: 0, elapsedMs: 0, stopReason: 'not-started' };

    function finish(result, exact, fallbackReason) {
      if (!result || (legal.length ? !legal.includes(result.action) : result.action !== null)) throw new Error('Combined strategy received an illegal result.');
      const source = result.diagnostics || {};
      return { ...result, probability: exact ? result.probability : null, diagnostics: { ...source,
        strategyVersion: STRATEGY_VERSION, evaluationVersion: EVALUATION_VERSION, difficulty: 'ultimate', searchProfile: config.searchProfile, budgetMs: config.budgetMs,
        elapsedMs: now() - started, exact: exact, endgame: { ...endgame }, search: { ...search },
        visitedNodes: (endgame.visitedNodes || 0) + (search.visitedNodes || 0),
        completedDepth: exact ? 0 : source.completedDepth || 0,
        stopReason: exact ? 'exact-solved' : fallbackReason || source.stopReason || 'completed',
        fallbackReason: fallbackReason || null
      } };
    }
    function staticFallback(reason) {
      const fallbackStarted = now();
      const result = Classic.chooseAction(state, 'medium', rng);
      search.attempted = true; search.budgetMs = 0; search.elapsedMs = now() - fallbackStarted;
      search.mode = 'static-fallback'; search.stopReason = reason;
      return finish(result, false, reason);
    }
    if (legal.length === 0) return staticFallback('no-root-action');
    if (remaining() <= 0) return staticFallback('total-budget-exhausted');

    endgame.applicable = Endgame.canSolve(state);
    if (endgame.applicable && config.maxEndgameStates > 0 && config.endgameBudgetMs > 0) {
      // 节点实验统一移除墙钟保护，但有限状态额度仍冻结，保证结果不依赖机器负载。
      const allowance = config.budgetMs === Infinity ? Infinity : Math.min(config.endgameBudgetMs, remaining());
      if (allowance > 0) {
        const endgameStarted = now();
        const result = Endgame.analyze(state, { budgetMs: allowance, maxStates: config.maxEndgameStates });
        Object.assign(endgame, result.diagnostics || {}, { applicable: true, attempted: true, budgetMs: allowance, elapsedMs: now() - endgameStarted, complete: result.complete === true, exact: result.complete === true });
        if (result.complete) {
          if (!Number.isFinite(result.probability) || result.probability < 0 || result.probability > 1) throw new Error('Exact endgame result has invalid probability.');
          return finish(result, true);
        }
      } else endgame.stopReason = 'total-budget-exhausted';
    } else if (endgame.applicable) endgame.stopReason = 'disabled';

    const searchBudget = remaining();
    if (searchBudget <= 0) return staticFallback('total-budget-exhausted');
    const searchStarted = now();
    const searchOptions = { budgetMs: searchBudget, maxNodes: config.maxNodes, maxDepth: config.maxDepth, maxCacheEntries: config.maxCacheEntries };
    const result = config.searchProfile === 'classic' ? Classic.chooseAction(state, 'ultimate', rng, searchOptions)
      : (config.searchProfile === 'hybrid' ? Hybrid : Completion).chooseAction(state, rng, searchOptions);
    Object.assign(search, result.diagnostics || {}, { attempted: true, budgetMs: searchBudget, elapsedMs: now() - searchStarted, mode: config.searchProfile });
    return finish(result, false);
  }
  return Object.freeze({ STRATEGY_VERSION, EVALUATION_VERSION, DEFAULT_CONFIG, SEARCH_PROFILES, chooseAction });
}));
