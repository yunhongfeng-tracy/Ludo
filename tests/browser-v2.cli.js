// 成品离线整局与取消验证。通过真实按钮和只读快照驱动，不注入骰点或棋局。
async (page) => {
  const errors = [], requests = [];
  await page.context().setOffline(page.url().startsWith('file:'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.context().setOffline(true);
  page.on('pageerror', error => { errors.push(error.message); page.evaluate(message => { if (window.__v2Report) window.__v2Report.errors.push(message); }, error.message).catch(() => {}); });
  page.on('request', request => { if (/^https?:/.test(request.url())) { requests.push(request.url()); page.evaluate(url => { if (window.__v2Report) window.__v2Report.requests.push(url); }, request.url()).catch(() => {}); } });
  await page.evaluate(() => {
    if (LudoAI.STRATEGY_VERSION !== 'four-level-ultimate-v2@1') throw new Error('Product v2 facade was not loaded.');
    if (LudoGame.snapshot().viewingUpdates) document.querySelector('.back-to-game').click();
    window.__v2Report = { status: 'running', startedAt: new Date().toISOString(), entry: location.href,
      userAgent: navigator.userAgent, strategyVersion: LudoAI.STRATEGY_VERSION, evaluationVersion: LudoAI.EVALUATION_VERSION,
      config: LudoAI.LEVEL_CONFIGS.ultimate, games: [], decisions: [], cancellation: null, errors: [], requests: [] };
    const report = window.__v2Report;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const seen = new Set();
    function observe() {
      const snapshot = LudoGame.snapshot(), decision = LudoGame.diagnostics();
      if (snapshot.error) throw new Error(snapshot.error);
      const diagnostics = decision && decision.diagnostics;
      if (diagnostics && diagnostics.fallback) throw new Error('Unexpected Worker fallback: ' + JSON.stringify(diagnostics));
      if (diagnostics && diagnostics.execution === 'worker' && !seen.has(diagnostics.requestId)) {
        seen.add(diagnostics.requestId); report.decisions.push(diagnostics);
      }
      return snapshot;
    }
    function humanMove(snapshot) {
      if (snapshot.busy || snapshot.state.activePlayer !== 0) return;
      if (snapshot.state.phase === 'awaitingRoll') document.getElementById('roll-button').click();
      else if (snapshot.state.phase === 'awaitingMove') document.querySelector('.token.red.legal').click();
    }
    window.__v2Task = (async () => {
      for (const difficulty of ['advanced', 'ultimate']) {
        document.querySelector('[data-difficulty="' + difficulty + '"]').click();
        document.getElementById('roll-button').click();
        const deadline = performance.now() + 160000;
        while (true) {
          const snapshot = observe();
          if (snapshot.state.phase === 'finished' && !snapshot.busy) {
            if (!document.getElementById('result-dialog').open) throw new Error('Result dialog missing.');
            if (!report.decisions.some(item => item.difficulty === difficulty && item.completedDepth > 0)) throw new Error('No search layer completed: ' + difficulty);
            report.games.push({ difficulty, rolls: snapshot.rollCount, winner: snapshot.state.winner, finalState: snapshot.state });
            document.getElementById('play-again').click();
            break;
          }
          humanMove(snapshot);
          if (performance.now() > deadline) throw new Error('Full game exceeded its test deadline.');
          await wait(8);
        }
      }
      document.querySelector('[data-difficulty="ultimate"]').click();
      document.getElementById('roll-button').click();
      const deadline = performance.now() + 60000;
      while (true) {
        const snapshot = observe();
        if (snapshot.activity === 'thinking') {
          const before = performance.now();
          document.getElementById('restart-button').click();
          document.getElementById('confirm-restart').click();
          const handlerMs = performance.now() - before;
          await wait(1600);
          const after = LudoGame.snapshot(), worker = LudoGame.workerStatus();
          if (after.started || after.busy || after.rollCount || worker.pending) throw new Error('Cancelled result changed new game.');
          if (handlerMs > 50) throw new Error('Restart handler exceeded 50 ms.');
          report.cancellation = { handlerMs, worker, statePreserved: true };
          break;
        }
        humanMove(snapshot);
        if (performance.now() > deadline) throw new Error('Did not reach a cancellable search.');
        await wait(4);
      }
      const values = report.decisions.filter(item => item.difficulty === 'ultimate' && !item.coldStart).map(item => item.endToEndMs).filter(Number.isFinite).sort((a, b) => a - b);
      if (!values.length) throw new Error('No warm ultimate timing samples.');
      report.ultimateWorkerTiming = { count: values.length, p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values[values.length - 1] };
      if (report.ultimateWorkerTiming.p95Ms > 850) throw new Error('Warm ultimate P95 exceeded 850 ms.');
      if (report.errors.length || report.requests.length) throw new Error('Unexpected browser error or network request.');
      report.status = 'passed'; report.completedAt = new Date().toISOString();
    })().catch(error => { report.status = 'failed'; report.errors.push(String(error.stack || error)); report.completedAt = new Date().toISOString(); });
  });
  // 不阻塞工具等待整局，随后分段轮询 window.__v2Report。
  await page.evaluate(() => window.__v2Report.status);
  page.__v2ExternalEvents = { errors, requests };
}
