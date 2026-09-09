// Playwright CLI 实际页面验收；独立规则案例不注入生产棋局，也不冒充实际走棋截图。
async page => {
  const report = { kind: 'safe-cell-visual-alignment', url: page.url(), status: 'running', errors: [], cases: [], limitations: '桌面与窄视口 Chromium 验收，非手机真机；规则构造案例与真实点击案例分开记录。' };
  page.on('pageerror', error => report.errors.push(error.message));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const capture = () => page.evaluate(() => {
    const E = LudoEngine;
    const stage = document.getElementById('board-stage').getBoundingClientRect();
    const frame = document.querySelector('.board-frame').getBoundingClientRect();
    const visible = element => {
      for (let node = element; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    };
    const rect = bounds => ({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    const markers = [...document.querySelectorAll('[data-safe-cell]')].filter(visible).map(element => {
      const polygon = element.querySelector('polygon');
      const matrix = polygon.getScreenCTM();
      const vertices = [...polygon.points].map(point => new DOMPoint(point.x, point.y).matrixTransform(matrix));
      // 用屏幕顶点均值读取五角星的真正中心，避免把不对称包围盒中心误当作星心。
      const center = { x: vertices.reduce((sum, point) => sum + point.x, 0) / vertices.length,
        y: vertices.reduce((sum, point) => sum + point.y, 0) / vertices.length };
      const cell = E.RING.find(candidate => candidate.cellId === element.dataset.safeCell);
      const expected = { x: stage.x + (cell.col + .5) * stage.width / 15,
        y: stage.y + (cell.row + .5) * stage.height / 15 };
      const bounds = polygon.getBoundingClientRect();
      return { cellId: cell.cellId, row: cell.row, col: cell.col, center, expected,
        distance: Math.hypot(center.x - expected.x, center.y - expected.y), bounds: rect(bounds),
        containedInCell: bounds.x >= expected.x - stage.width / 30 && bounds.right <= expected.x + stage.width / 30 &&
          bounds.y >= expected.y - stage.height / 30 && bounds.bottom <= expected.y + stage.height / 30,
        largeEnough: bounds.width >= stage.width / 15 * .4 && bounds.height >= stage.height / 15 * .4,
        hitTarget: document.elementFromPoint(center.x, center.y)?.closest('#board-safety,#board-star-repairs')?.id || null };
    });
    // 旧星范围来自原始 863×858 PNG 的像素审查，不从修补层实现读取。
    const oldStarBounds = [[207,457,236,485], [368,247,397,274], [634,352,664,380], [475,561,504,590]];
    const repairLayer = document.getElementById('board-star-repairs');
    const repairs = [...repairLayer.children].map((element, index) => {
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
      const [x0, y0, x1, y1] = oldStarBounds[index];
      const region = { x0: frame.x + x0 * frame.width / 863, y0: frame.y + y0 * frame.height / 858,
        x1: frame.x + x1 * frame.width / 863, y1: frame.y + y1 * frame.height / 858 };
      return { visible: visible(element), bounds: rect(bounds), containsOldStar: bounds.x < region.x0 && bounds.y < region.y0 && bounds.right > region.x1 && bounds.bottom > region.y1,
        textured: style.backgroundImage.startsWith('url('), matchesBoardTexture: style.backgroundImage === getComputedStyle(document.querySelector('.board-art')).backgroundImage,
        masked: style.maskImage !== 'none', pointerEvents: style.pointerEvents };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, playing: document.body.classList.contains('playing'),
      stage: rect(stage), expectedIds: E.SAFE_INDICES.map(index => E.RING[index].cellId).sort(), markers, repairs,
      desktopOverlayVisible: visible(document.getElementById('board-safety')), mobileBoardVisible: visible(document.getElementById('board-svg')) };
  });
  const validate = (sample, desktop, label) => {
    assert(sample.markers.length === 8, `${label}: expected 8 visible safety markers, got ${sample.markers.length}`);
    assert(JSON.stringify(sample.markers.map(marker => marker.cellId).sort()) === JSON.stringify(sample.expectedIds), `${label}: rendered safety cells differ from engine`);
    for (const marker of sample.markers) {
      assert(marker.distance < .75, `${label}: ${marker.cellId} misses physical cell center by ${marker.distance}px`);
      assert(marker.containedInCell && marker.largeEnough, `${label}: ${marker.cellId} marker size does not fit its physical cell`);
      assert(!marker.hitTarget, `${label}: safety layer intercepts hit testing`);
    }
    assert(sample.desktopOverlayVisible === desktop && sample.mobileBoardVisible !== desktop, `${label}: wrong safety rendering mode`);
    assert(sample.repairs.length === 4, `${label}: missing old-star repairs`);
    for (const repair of sample.repairs) {
      assert(repair.visible === desktop, `${label}: wrong repair visibility`);
      if (desktop) assert(repair.containsOldStar && repair.textured && repair.matchesBoardTexture && repair.masked && repair.pointerEvents === 'none', `${label}: old-star repair does not cover its original artwork correctly`);
    }
  };
  try {
    await page.context().setOffline(false);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const viewport of [{ width:1536, height:1024 }, { width:1280, height:960 }, { width:390, height:844 }]) {
      await page.setViewportSize(viewport);
      await page.reload();
      await page.waitForFunction(() => window.LudoGame && document.querySelectorAll('[data-safe-cell]').length === 16);
      await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.animationName === 'arrive').map(animation => animation.finished.catch(() => {}))));
      await page.evaluate(() => window.scrollTo(0,0));
      const desktop = viewport.width > 780;
      const before = await capture();
      validate(before, desktop, `${viewport.width} lobby`);
      await page.screenshot({ path:`output/playwright/safety-${viewport.width}-before.png`, fullPage:true });
      await page.locator('[data-difficulty="beginner"]').click();
      await page.locator('#roll-button').click();
      await page.waitForFunction(() => document.body.classList.contains('playing'));
      await page.evaluate(() => window.scrollTo(0,0));
      const after = await capture();
      validate(after, desktop, `${viewport.width} playing`);
      for (const marker of before.markers) {
        const corresponding = after.markers.find(candidate => candidate.cellId === marker.cellId);
        assert(Math.hypot(marker.center.x - corresponding.center.x, marker.center.y - corresponding.center.y) < .75, `${viewport.width}: safety marker jumps after start`);
      }
      await page.screenshot({ path:`output/playwright/safety-${viewport.width}-playing.png`, fullPage:true });
      const clicks = [];
      // 用正常骰子走到红子出营，再实际点击其环路棋子，覆盖安全图层下的输入。
      for (let attempt = 0; attempt < 160 && !clicks.some(click => click.from >= 0); attempt++) {
        const snapshot = await page.evaluate(() => LudoGame.snapshot());
        assert(!snapshot.error, snapshot.error);
        if (!snapshot.busy && snapshot.state.activePlayer === 0) {
          if (snapshot.state.phase === 'awaitingRoll') await page.locator('#roll-button').click();
          else if (snapshot.state.phase === 'awaitingMove') {
            // 窄屏点击侧栏可能自动滚动，把真实棋盘移回视口再做命中检测。
            await page.evaluate(() => window.scrollTo(0,0));
            const action = await page.evaluate(() => {
              const snapshot = LudoGame.snapshot(), legal = LudoEngine.getLegalActions(snapshot.state);
              const token = legal.find(id => snapshot.state.tokenProgress[0][id] >= 0) ?? legal[0];
              const element = document.getElementById(`token-0-${token}`), bounds = element.getBoundingClientRect();
              const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
              return { token, from:snapshot.state.tokenProgress[0][token], expected:LudoEngine.applyAction(snapshot.state, token).tokenProgress[0][token],
                pointerCanReach: hit?.closest('.token') === element, hitTarget:hit?.closest('[id]')?.id || null };
            });
            assert(action.pointerCanReach, `${viewport.width}: actual token is blocked by ${action.hitTarget || 'offscreen target'}`);
            await page.locator(`#token-0-${action.token}`).click();
            await page.waitForFunction(({token, expected}) => LudoGame.snapshot().state.tokenProgress[0][token] === expected, action);
            clicks.push(action);
          }
        } else await page.waitForTimeout(50);
      }
      assert(clicks.some(click => click.from >= 0), `${viewport.width}: no actual ring token click observed`);
      report.cases.push({ viewport, before, after, realTokenClicks:clicks });
    }
    report.independentRules = await page.evaluate(() => {
      const E = LudoEngine, renderedIds = new Set([...document.querySelectorAll('#board-svg [data-safe-cell]')].map(element => element.dataset.safeCell));
      const results = [];
      for (let actor = 0; actor < 2; actor++) for (let target = 0; target < E.RING.length; target++) {
        const progress = (target - E.START_OFFSETS[actor] + E.RING.length) % E.RING.length;
        const enemyProgress = (target - E.START_OFFSETS[1-actor] + E.RING.length) % E.RING.length;
        if (progress > 50 || enemyProgress > 50) continue;
        const initial = E.createGame(actor);
        initial.tokenProgress[actor][3] = progress === 0 ? -1 : progress - 1;
        initial.tokenProgress[1-actor][3] = enemyProgress;
        const result = E.applyAction(E.applyRoll(initial, progress === 0 ? 6 : 1), 3);
        const marked = renderedIds.has(E.RING[target].cellId);
        const remained = result.tokenProgress[1-actor][3] === enemyProgress;
        if (marked !== remained || (!marked && result.tokenProgress[1-actor][3] !== -1)) throw new Error(`Marker/capture mismatch actor ${actor}, ring ${target}`);
        results.push({actor, target, marked, enemyAfter:result.tokenProgress[1-actor][3]});
      }
      return { rulesetId:E.RULESET_ID, total:results.length, safetyCoexist:results.filter(result => result.marked).length,
        ordinaryCapture:results.filter(result => !result.marked).length,
        reportedRed4AtRing8:results.find(result => result.actor === 0 && result.target === 8),
        neighboringRing7:results.find(result => result.actor === 0 && result.target === 7) };
    });
    assert(!report.errors.length, `Page errors: ${report.errors.join('; ')}`);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = error.stack || String(error);
  }
  await page.evaluate(report => { window.__ludoSafetyReport = report; }, report);
  if (report.status !== 'passed') throw new Error(report.failure);
  console.log(JSON.stringify({status:report.status, viewports:report.cases.map(item => item.viewport.width), rules:report.independentRules}));
}
