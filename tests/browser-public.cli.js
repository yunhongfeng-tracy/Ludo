// 使用 playwright-cli 对真实公网地址验收，加载后断网完成对局。
async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().setOffline(false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const response = await page.reload();
  if (response.status() !== 200) throw new Error('Public page did not return 200');
  if (await page.locator('.token').count() !== 8) throw new Error('Incomplete board');
  const capabilities = await page.evaluate(() => ({ random: typeof crypto.getRandomValues, title: document.title, url: location.href }));
  if (capabilities.random !== 'function') throw new Error('Dice RNG unavailable over HTTP');
  await page.locator('#rules-button').click();
  await page.locator('[data-close="rules-dialog"]').last().click();
  if (await page.locator('#sound-button').getAttribute('aria-pressed') === 'true') await page.locator('#sound-button').click();
  await page.locator('#sound-button').click();
  if (await page.locator('#sound-button').getAttribute('aria-pressed') !== 'true') throw new Error('Audio initialization failed');
  await page.locator('#sound-button').click();
  await page.locator('[data-difficulty="medium"]').click();
  await page.context().setOffline(true);
  await page.locator('#roll-button').click();
  let finalState;
  const feedbackChecks = new Map();
  for (let index = 0; index < 15000; index++) {
    const snapshot = await page.evaluate(() => LudoGame.snapshot());
    if (snapshot.error) throw new Error(snapshot.error);
    if (!snapshot.busy && snapshot.lastMove) {
      const key = `${snapshot.generation}:${snapshot.revision}:${snapshot.lastMove.player}:${snapshot.lastMove.token}:${snapshot.lastMove.to}`;
      if (!feedbackChecks.has(key)) {
        const feedback = await page.evaluate(() => {
          const current = LudoGame.snapshot();
          if (current.busy) return null;
          const move = current.lastMove;
          const marker = document.querySelector('#last-move-layer .last-move-mark');
          return { kind: move.kind, player: move.player, textMatches: document.querySelector('#move-feedback').textContent === move.message,
            markerMatches: marker?.dataset.cellId === move.toCell.cellId && Number(marker?.dataset.player) === move.player && Number(marker?.dataset.token) === move.token,
            lastTokenMatches: document.querySelector('#token-layer .last-moved')?.id === `token-${move.player}-${move.token}`,
            ghostCount: document.querySelectorAll('.capture-ghost').length };
        });
        if (feedback) {
          if (!feedback.textMatches || !feedback.markerMatches || !feedback.lastTokenMatches || feedback.ghostCount) throw new Error('Public move feedback is inconsistent');
          feedbackChecks.set(key, feedback);
        }
      }
    }
    if (snapshot.state.phase === 'finished' && !snapshot.busy) {
      if (!await page.locator('#result-dialog').isVisible()) throw new Error('Missing result dialog');
      finalState = snapshot;
      break;
    }
    if (!snapshot.busy && snapshot.state.activePlayer === 0) {
      if (snapshot.state.phase === 'awaitingRoll') await page.locator('#roll-button').click();
      else await page.locator('.token.red.legal').first().click();
    } else await page.waitForTimeout(12);
  }
  if (!finalState) throw new Error('Game did not finish');
  if (!feedbackChecks.size || ![0, 1].every(player => [...feedbackChecks.values()].some(check => check.player === player))) throw new Error('Missing move feedback coverage');
  await page.locator('#play-again').click();
  const reset = await page.evaluate(() => LudoGame.snapshot());
  if (reset.started || reset.busy || reset.rollCount) throw new Error('New game reset failed');
  if (errors.length) throw new Error(JSON.stringify(errors));
  await page.evaluate(report => { window.__ludoPublicReport = report; }, {
    capabilities, status: response.status(), viewport: page.viewportSize(),
    completedAfterDisconnect: true, difficulty: 'medium', rolls: finalState.rollCount,
    winner: finalState.state.winner, finalState: finalState.state, errors,
    audioInitialized: true, resetToLobby: true,
    feedbackChecks: feedbackChecks.size, feedbackKinds: [...new Set([...feedbackChecks.values()].map(check => check.kind))],
    scope: 'Current public connection and desktop Chrome, not a cross-ISP availability guarantee.'
  });
  await page.context().setOffline(false);
}
