// 本地页面生命周期、重开和布局检查，生命周期恢复采用明确标记的合成事件。
async (page) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  const checks = [];
  await page.locator("#roll-button").click();
  await page.waitForFunction(() => { const s = LudoGame.snapshot(); return !s.busy && s.state.activePlayer === 0; });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const recovered = await page.evaluate(() => {
    const before = LudoGame.snapshot();
    document.querySelector("#roll-button").click();
    const during = LudoGame.snapshot();
    if (!during.busy || during.activity !== "rolling") throw new Error("未进入掷骰动画");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    const after = LudoGame.snapshot();
    if (after.busy || after.rollCount !== before.rollCount + 1 || JSON.stringify(after.state) !== JSON.stringify(during.state)) throw new Error("恢复重复掷骰或未收尾");
    return { before: before.rollCount, after: after.rollCount, statePreserved: true, busy: after.busy };
  });
  checks.push({ name: "synthetic-page-lifecycle-roll", ...recovered });
  await page.waitForTimeout(540);
  await page.locator("#restart-button").click();
  await page.locator("#confirm-restart").click();
  const cancelled = await page.evaluate(() => {
    document.querySelector("#roll-button").click();
    document.querySelector("#roll-button").click();
    const during = LudoGame.snapshot();
    document.querySelector("#restart-button").click();
    document.querySelector("#confirm-restart").click();
    return during;
  });
  await page.waitForTimeout(1300);
  const lobby = await page.evaluate(() => LudoGame.snapshot());
  if (lobby.started || lobby.busy || lobby.rollCount || lobby.state.tokenProgress.flat().some(x => x !== -1)) throw new Error("旧异步操作污染重开后的棋局");
  checks.push({ name: "restart-cancels-old-async", startedDuring: cancelled.started, lobbyRestored: true });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => {
      const board = document.querySelector("#board-stage").getBoundingClientRect();
      const panel = document.querySelector("#turn-panel").getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, boardRatio: board.width / board.height, panelHeight: panel.height, boardLeft: board.left };
    });
    if (layout.scrollWidth > layout.clientWidth || Math.abs(layout.boardRatio - 1) > 0.01) throw new Error("棋盘溢出或不再为方形");
    const before = await page.evaluate(() => ({ y: scrollY, h: document.querySelector("#turn-panel").getBoundingClientRect().height }));
    await page.locator('[data-difficulty="beginner"]').dispatchEvent("click");
    await page.locator('[data-difficulty="medium"]').dispatchEvent("click");
    const after = await page.evaluate(() => ({ y: scrollY, h: document.querySelector("#turn-panel").getBoundingClientRect().height }));
    if (before.y !== after.y || before.h !== after.h) throw new Error("切换难度引起滚动或面板跳动");
    checks.push({ name: "responsive-and-stable-switch", width, ...layout });
  }
  await page.evaluate(report => { window.__ludoRecoveryReport = report; console.log(JSON.stringify(report)); }, { checks, limitation: "合成生命周期事件不等同于各浏览器真实 BFCache 覆盖；窄视口不等同于手机真机。" });
}
