// 由 playwright-cli run-code --filename 执行，使用真实 DOM 操作和真实骰子。
async (page) => {
  const errors = [];
  const network = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.context().setOffline(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.locator("#rules-button").click();
  if (!await page.locator("#rules-dialog").isVisible()) throw new Error("玩法弹窗未打开");
  await page.locator('[data-close="rules-dialog"]').last().click();
  await page.locator('[data-difficulty="beginner"]').click();
  await page.locator("#roll-button").click();
  if (page.viewportSize().width <= 780) {
    const dock = await page.locator("#turn-panel").boundingBox();
    if (!dock || dock.y < 0 || dock.y + dock.height > page.viewportSize().height) throw new Error("底部操作区超出手机视口");
  }
  const restartSelector = page.viewportSize().width <= 780 ? "#mobile-restart" : "#restart-button";
  await page.locator(restartSelector).click();
  await page.locator('[data-close="restart-dialog"]').click();
  if (!await page.evaluate(() => LudoGame.snapshot().started)) throw new Error("取消重开改变了棋局");
  await page.locator(restartSelector).click();
  await page.locator("#confirm-restart").click();
  const lobby = await page.evaluate(() => LudoGame.snapshot());
  if (lobby.started || lobby.busy || lobby.rollCount !== 0) throw new Error("重新开始没有恢复大厅");
  const games = [];
  for (const difficulty of ["beginner", "medium"]) {
    await page.locator(`[data-difficulty="${difficulty}"]`).click();
    await page.locator("#roll-button").click();
    for (let iteration = 0; iteration < 15000; iteration++) {
      const snapshot = await page.evaluate(() => LudoGame.snapshot());
      if (snapshot.error) throw new Error(snapshot.error);
      if (snapshot.state.phase === "finished" && !snapshot.busy) {
        if (!await page.locator("#result-dialog").isVisible()) throw new Error("终局缺少结果弹窗");
        games.push({ difficulty, rolls: snapshot.rollCount, winner: snapshot.state.winner, captures: snapshot.captureCount, state: snapshot.state });
        break;
      }
      if (!snapshot.busy && snapshot.state.activePlayer === 0) {
        if (snapshot.state.phase === "awaitingRoll") await page.locator("#roll-button").click();
        else if (page.viewportSize().width <= 780) await page.locator('[data-move]:enabled').first().click();
        else await page.locator('.token.red.legal').first().click();
      } else await page.waitForTimeout(12);
    }
    if (games.length !== (["beginner", "medium"].indexOf(difficulty) + 1)) throw new Error("完整浏览器对局超出上限");
    await page.locator("#play-again").click();
  }
  if (errors.length || network.length) throw new Error(JSON.stringify({ errors, network }));
  await page.evaluate(report => { window.__ludoBrowserReport = report; console.log(JSON.stringify(report)); }, { kind: "browser-offline-gameplay", url: page.url(), viewport: page.viewportSize(), games, errors, httpRequests: network, limitations: "界面功能验收，不是难度强度测试。减少动态效果以加快对局。" });
}
