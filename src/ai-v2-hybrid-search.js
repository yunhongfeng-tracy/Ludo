/* 开发候选：保留完整概率搜索，叶节点使用混合评价的默认 full 配置。 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./ai.js'), require('./ai-v2-hybrid-eval.js'));
  } else root.LudoV2HybridSearch = factory(root.LudoAI, root.LudoV2HybridEval);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Classic, Evaluation) {
  'use strict';
  if (!Classic || !Evaluation) throw new Error('LudoV2HybridSearch requires Classic AI and HybridEval.');
  const STRATEGY_VERSION = 'classic-home-efficiency-expectiminimax@1';
  const DEFAULT_CONFIG = Object.freeze({ budgetMs: 600, maxNodes: 60000, maxDepth: 64, maxCacheEntries: 20000 });
  const evaluator = Object.freeze({ version: Evaluation.EVALUATION_VERSION,
    evaluate: Evaluation.evaluate, fastValue: Evaluation.fastValue });

  function chooseAction(state, rng, options) {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
      throw new TypeError('Hybrid search options must be an object.');
    }
    const config = { ...DEFAULT_CONFIG, ...options };
    const result = Classic.chooseActionWithEvaluator(state, 'ultimate', rng, config, evaluator);
    return { ...result, diagnostics: { ...result.diagnostics, strategyVersion: STRATEGY_VERSION,
      evaluationProfile: 'full' } };
  }

  return Object.freeze({ STRATEGY_VERSION: STRATEGY_VERSION, EVALUATION_VERSION: Evaluation.EVALUATION_VERSION,
    DEFAULT_CONFIG: DEFAULT_CONFIG, chooseAction: chooseAction });
}));
