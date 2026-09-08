// 复古棋盘回归：实际开局、掷骰、双方出营，检查动态棋子与底图的对齐。
async page => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.getByRole('button', { name: '初级', exact: true }).click();
  await page.getByRole('button', { name: '开始对局', exact: true }).click();
  await page.waitForTimeout(250);
  const result = await page.evaluate(async () => {
    // 来自底图八个方格的实际像素中心，独立于页面的布局变量。
    const centers = [[[150.5, 611], [241.5, 611], [150.5, 701], [241.5, 701]],
      [[631, 140], [720, 140], [631, 228], [720, 228]]];
    const departed = new Set();
    let yardChecks = 0;
    let pathChecks = 0;
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      const snapshot = LudoGame.snapshot();
      if (snapshot.error) throw new Error(snapshot.error);
      if (!snapshot.busy) {
        const board = document.querySelector('.board-frame').getBoundingClientRect();
        const stage = document.querySelector('.board-stage').getBoundingClientRect();
        for (const token of document.querySelectorAll('.token')) {
          const style = getComputedStyle(token);
          if (style.backgroundImage !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
              style.borderWidth !== '0px' || style.boxShadow !== 'none') {
            throw new Error(`Duplicate token backing: ${token.id}`);
          }
          const player = Number(token.dataset.player), number = Number(token.dataset.token);
          const progress = snapshot.state.tokenProgress[player][number];
          const rect = token.getBoundingClientRect();
          if (progress === -1) {
            const [x, y] = centers[player][number];
            if (Math.abs(rect.x + rect.width / 2 - board.x - x) > 1 ||
                Math.abs(rect.y + rect.height / 2 - board.y - y) > 1) {
              throw new Error(`Yard alignment: ${token.id}`);
            }
            yardChecks++;
          } else if (!token.classList.contains('stacked') && !token.classList.contains('finished')) {
            const cell = LudoEngine.position(player, progress);
            const x = stage.x + (cell.col + 0.5) / 15 * stage.width;
            const y = stage.y + (cell.row + 0.5) / 15 * stage.height;
            if (Math.abs(rect.x + rect.width / 2 - x) > 1 || Math.abs(rect.y + rect.height / 2 - y) > 1) {
              throw new Error(`Path alignment: ${token.id}`);
            }
            if (token.firstElementChild.getBoundingClientRect().width !== 48) throw new Error('Token size changed after departure');
            departed.add(player);
            pathChecks++;
          }
        }
        if (departed.size === 2) return { yardChecks, pathChecks, rollCount: snapshot.rollCount, bothPlayersDeparted: true };
        if (snapshot.state.activePlayer === 0) {
          if (snapshot.state.phase === 'awaitingRoll') document.querySelector('#roll-button').click();
          else document.querySelector('.token.red.legal')?.click();
        }
      }
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    throw new Error('Timed out waiting for both players to leave their yards');
  });
  await page.screenshot({ path: 'output/playwright/v056-actual-moves.png' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: '重新开始', exact: true }).scrollIntoViewIfNeeded();
  const restart = await page.getByRole('button', { name: '重新开始', exact: true }).boundingBox();
  if (!restart || restart.y < 0 || restart.y + restart.height > 800) throw new Error('Restart button is clipped');
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.evaluate(() => window.scrollTo(0, 0));
  if (errors.length) throw new Error(errors.join('; '));
  return { ...result, shortDesktopCanScroll: true, errors };
}
