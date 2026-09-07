// 请求成品内真实 Worker，覆盖随机整局没有必然触发的精确残局与预算中断分支。
async (page) => {
  await page.context().setOffline(true);
  const report = await page.evaluate(async () => {
    const E = LudoEngine, A = LudoAI;
    const client = LudoAIClient.create(document.getElementById('ai-worker-source').textContent);
    const layouts = [
      { name: 'opening', own: [0, 6, 12, -1], enemy: [3, 10, 24, -1], die: 6 },
      { name: 'middle', own: [0, 12, 27, -1], enemy: [4, 18, 45, -1], die: 3 },
      { name: 'small-home', own: [53, 55, 56, 56], enemy: [54, 55, 56, 56], die: 1 },
      { name: 'large-home', own: [51, 52, 53, 54], enemy: [51, 52, 53, 54], die: 1 }
    ];
    const samples = [], errors = [];
    const startedAt = new Date().toISOString();
    try {
      for (let repeat = 0; repeat < 3; repeat++) for (const layout of layouts) for (const player of [0, 1]) {
        const before = E.createGame(player);
        before.tokenProgress = player === 0 ? [layout.own.slice(), layout.enemy.slice()] : [layout.enemy.slice(), layout.own.slice()];
        const state = E.applyRoll(before, layout.die), saved = JSON.stringify(state);
        const result = await client.choose(state, 'ultimate', { gameId: 'v2-fixture-verification', stateRevision: samples.length,
          strategyVersion: A.STRATEGY_VERSION, evaluationVersion: A.EVALUATION_VERSION, legalActions: E.getLegalActions(state) });
        if (JSON.stringify(state) !== saved || !E.getLegalActions(state).includes(result.action)) throw new Error('Fixture contract failed.');
        if (result.diagnostics.difficulty !== 'ultimate' || result.diagnostics.strategyVersion !== A.ULTIMATE_STRATEGY_VERSION) throw new Error('Worker strategy identity mismatch.');
        if (result.diagnostics.exact !== (result.probability !== null)) throw new Error('Probability/exact boundary failed.');
        if (layout.name === 'small-home' && !result.diagnostics.exact) throw new Error('Small home fixture was not solved exactly.');
        if (layout.name === 'large-home' && !result.diagnostics.endgame.attempted) throw new Error('Large home fixture skipped endgame attempt.');
        if (!result.diagnostics.exact && result.diagnostics.endgame.attempted && result.diagnostics.search.budgetMs > 600 - result.diagnostics.endgame.elapsedMs + 2) throw new Error('Search received an extra full budget.');
        samples.push({ fixture: layout.name, player, repeat, state, action: result.action, probability: result.probability, diagnostics: result.diagnostics });
      }
    } catch (error) { errors.push(String(error.stack || error)); }
    finally { client.cancel(); }
    const warm = samples.filter(item => !item.diagnostics.coldStart).map(item => item.diagnostics.endToEndMs).sort((a, b) => a - b);
    const p95Ms = warm[Math.ceil(warm.length * .95) - 1];
    const result = { startedAt, completedAt: new Date().toISOString(), entry: location.href, userAgent: navigator.userAgent,
      strategyVersion: A.STRATEGY_VERSION, config: A.LEVEL_CONFIGS.ultimate,
      count: samples.length, exact: samples.filter(item => item.diagnostics.exact).length,
      interruptedEndgames: samples.filter(item => item.diagnostics.endgame.attempted && !item.diagnostics.exact).length,
      p95Ms, maxMs: Math.max(...samples.map(item => item.diagnostics.endToEndMs)), errors, samples,
      passed: samples.length === 24 && errors.length === 0 && p95Ms <= 850 && samples.every(item => item.diagnostics.endToEndMs < 1500) };
    window.__v2FixturesReport = result;
    return { ...result, samples: undefined };
  });
  if (!report.passed) throw new Error(JSON.stringify(report));
}
