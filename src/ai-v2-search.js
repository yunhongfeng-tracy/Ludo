/* 终极候选：保留完整概率搜索，以完成效率评价替换叶节点价值。 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ai.js'), require('./ai-v2-eval.js'));
  else root.LudoV2Search = factory(root.LudoAI, root.LudoV2Eval);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Classic, Evaluation) {
  'use strict';
  const STRATEGY_VERSION = 'completion-cost-expectiminimax@1';
  const DEFAULT_CONFIG = Object.freeze({ budgetMs: 600, maxNodes: 120000, maxDepth: 64, maxCacheEntries: 20000, profile: 'full' });
  function chooseAction(state, rng, options) {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new TypeError('Search options must be an object.');
    const config = { ...DEFAULT_CONFIG, ...options };
    if (!Object.hasOwn(Evaluation.PROFILES, config.profile)) throw new RangeError('Unknown evaluation profile.');
    const evaluation = {
      version: Evaluation.EVALUATION_VERSION + ':' + config.profile,
      evaluate: (next, perspective) => Evaluation.evaluate(next, perspective, config.profile),
      fastValue: (next, perspective) => Evaluation.fastValue(next, perspective, config.profile)
    };
    const result = Classic.chooseActionWithEvaluator(state, 'ultimate', rng, config, evaluation);
    return { ...result, diagnostics: { ...result.diagnostics, strategyVersion: STRATEGY_VERSION, profile: config.profile } };
  }
  return Object.freeze({ STRATEGY_VERSION, EVALUATION_VERSION: Evaluation.EVALUATION_VERSION, DEFAULT_CONFIG, chooseAction });
}));
