/* 与主页面使用同一份棋规和策略代码，Worker 只返回建议，不写真实棋局。 */
'use strict';
self.postMessage({ type: 'ready', strategyVersion: LudoAI.STRATEGY_VERSION,
  evaluationVersion: LudoAI.EVALUATION_VERSION });
self.onmessage = function (event) {
  const request = event.data;
  if (!request || request.type !== 'choose') return;
  const identity = { requestId: request.requestId, gameId: request.gameId,
    stateRevision: request.stateRevision, rulesetId: request.rulesetId,
    boardVersion: request.boardVersion, difficulty: request.difficulty,
    strategyVersion: request.strategyVersion, evaluationVersion: request.evaluationVersion };
  try {
    if (request.strategyVersion !== LudoAI.STRATEGY_VERSION ||
        request.evaluationVersion !== LudoAI.EVALUATION_VERSION ||
        request.rulesetId !== request.state.rulesetId || request.boardVersion !== request.state.boardVersion) {
      throw new Error('Worker request version mismatch');
    }
    const result = LudoAI.chooseAction(request.state, request.difficulty, undefined);
    self.postMessage({ type: 'result', ...identity, result });
  } catch (error) {
    self.postMessage({ type: 'failure', ...identity, message: error instanceof Error ? error.message : String(error) });
  }
};
