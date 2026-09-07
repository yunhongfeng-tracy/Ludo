/* 产品策略入口：前三档保持原行为，终极使用经过筛选的 V2 组合。 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./ai.js'), require('./ai-v2-combined.js'));
  } else root.LudoAI = factory(root.LudoAI, root.LudoV2Combined);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Classic, Combined) {
  'use strict';
  if (!Classic || !Combined) throw new Error('LudoAI policy requires Classic AI and V2Combined.');

  const STRATEGY_VERSION = 'four-level-ultimate-v2@1';
  const EVALUATION_VERSION = Classic.EVALUATION_VERSION + '|ultimate:' + Combined.EVALUATION_VERSION;
  const LEVEL_CONFIGS = Object.freeze({ ...Classic.LEVEL_CONFIGS, ultimate: Combined.DEFAULT_CONFIG });
  const LEVEL_VERSIONS = Object.freeze({
    beginner: Object.freeze({ strategy: Classic.STRATEGY_VERSION, evaluation: Classic.EVALUATION_VERSION }),
    medium: Object.freeze({ strategy: Classic.STRATEGY_VERSION, evaluation: Classic.EVALUATION_VERSION }),
    advanced: Object.freeze({ strategy: Classic.STRATEGY_VERSION, evaluation: Classic.EVALUATION_VERSION }),
    ultimate: Object.freeze({ strategy: Combined.STRATEGY_VERSION, evaluation: Combined.EVALUATION_VERSION })
  });

  function chooseAction(state, difficulty, rng, options) {
    if (difficulty === 'ultimate') return Combined.chooseAction(state, rng, options);
    // 连同默认档位、参数验证、随机消费及诊断字段一起保留原入口行为。
    return Classic.chooseAction(state, difficulty, rng, options);
  }

  return Object.freeze({ ...Classic, STRATEGY_VERSION: STRATEGY_VERSION,
    EVALUATION_VERSION: EVALUATION_VERSION, LEVEL_CONFIGS: LEVEL_CONFIGS,
    LEVEL_VERSIONS: LEVEL_VERSIONS, LEGACY_STRATEGY_VERSION: Classic.STRATEGY_VERSION,
    ULTIMATE_STRATEGY_VERSION: Combined.STRATEGY_VERSION,
    ULTIMATE_SEARCH_PROFILES: Combined.SEARCH_PROFILES, chooseAction: chooseAction });
}));
