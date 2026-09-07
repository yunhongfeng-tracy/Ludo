// 验证离线版本记录、浏览历史以及摇骰、移动、搜索中的暂停恢复。
async (page) => {
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.context().setOffline(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (!await page.locator('#updates-page').isVisible()) throw new Error('Direct updates URL did not open updates');
  if (await page.locator('.release-entry').count() !== 6) throw new Error('Release history is incomplete');
  if (!await page.locator('.release-entry.latest .release-version').textContent().then(text => text.includes('0.3.0'))) throw new Error('Latest release version is stale');
  if (await page.locator('#game-page').isVisible()) throw new Error('Two pages visible at once');
  const directTitle = await page.title();
  await page.locator('.back-to-game').click();
  await page.waitForFunction(() => !LudoGame.snapshot().viewingUpdates);
  await page.locator('.site-footer [data-updates-link]').click();
  await page.waitForFunction(() => document.activeElement.id === 'updates-title');
  const savedGameScroll = await page.evaluate(() => ({ game: document.getElementById('game-page').hidden, y: scrollY }));
  await page.goBack();
  await page.waitForFunction(() => !LudoGame.snapshot().viewingUpdates);
  await page.goForward();
  await page.waitForFunction(() => LudoGame.snapshot().viewingUpdates);
  await page.locator('.back-to-game').click();
  await page.locator('[data-difficulty="ultimate"]').click();
  await page.locator('#roll-button').click();

  // 通过已有只读快照驱动真实按钮，不改棋盘、不控制骰子或策略结果。
  const exercise = phase => page.evaluate(async phase => {
    const cases = window.__updatesCases || (window.__updatesCases = []), covered = new Set(cases.map(item => item.activity));
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frame = () => new Promise(requestAnimationFrame);
    const openUpdates = () => document.querySelector('.header-actions [data-updates-link]').click();
    const backToGame = () => document.querySelector('.back-to-game').click();
    const deadline = performance.now() + (phase === 'animations' ? 20000 : 80000);
    for (let step = 0; step < 30000; step++) {
      const snapshot = LudoGame.snapshot();
      if (snapshot.error) throw new Error(snapshot.error);
      const activity = snapshot.state.phase === 'finished' && snapshot.activity === 'moving' ? 'finishing' : snapshot.activity;
      if (['rolling', 'moving', 'thinking', 'finishing'].includes(activity) && !covered.has(activity)) {
        const state = JSON.stringify(snapshot.state);
        const rolls = snapshot.rollCount;
        const generation = snapshot.generation;
        openUpdates();
        for (let poll = 0; LudoGame.snapshot().busy && poll < 100; poll++) await wait(20);
        await wait(180);
        const paused = LudoGame.snapshot();
        if (paused.busy || !paused.viewingUpdates || JSON.stringify(paused.state) !== state || paused.rollCount !== rolls || paused.generation !== generation) {
          throw new Error('Pause changed committed game state: ' + activity);
        }
        if (activity === 'thinking' && LudoGame.workerStatus().pending) throw new Error('AI search was not cancelled');
        // 隐藏界面的直接事件也不能启动新动作。
        document.getElementById('roll-button').click();
        if (JSON.stringify(LudoGame.snapshot().state) !== state) throw new Error('Hidden game accepted an action');
        cases.push({ activity, rolls, preserved: true }); covered.add(activity);
        backToGame();
        await frame();
      }
      if (phase === 'animations' && covered.has('rolling') && covered.has('moving')) return { cases };
      const current = LudoGame.snapshot();
      if (current.state.phase === 'finished' && !current.busy) {
        if (!document.getElementById('result-dialog').open) throw new Error('Finished result not shown');
        const logsBefore = document.getElementById('activity-list').textContent;
        document.querySelector('[data-close="result-dialog"]').click();
        openUpdates(); backToGame();
        await frame();
        if (document.getElementById('result-dialog').open || document.getElementById('activity-list').textContent !== logsBefore) throw new Error('Dismissed result was reopened or announced twice');
        if (!['rolling', 'moving', 'thinking'].every(item => covered.has(item))) throw new Error('Missing activity coverage: ' + [...covered]);
        return { cases, rolls: current.rollCount, winner: current.state.winner, dismissedResultPreserved: true };
      }
      if (!current.busy && current.state.activePlayer === 0) {
        if (current.state.phase === 'awaitingRoll') document.getElementById('roll-button').click();
        else if (current.state.phase === 'awaitingMove') document.querySelector('.token.red.legal').click();
      }
      if (performance.now() > deadline) throw new Error('Browser game exceeded test deadline');
      await frame();
    }
    throw new Error('Game did not finish');
  }, phase);
  await exercise('animations');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await exercise('game');
  await page.locator('#roll-button').click();
  await page.locator('.header-actions [data-updates-link]').click();
  if (errors.length || requests.length) throw new Error(JSON.stringify({ errors, requests }));
  await page.evaluate(report => { window.__updatesReport = report; }, { directTitle, historyNavigation: true, savedGameScroll, ...result, errors, requests });
}
