// 通过 playwright-cli run-code --filename 执行，验证同一真实面板的状态切换。
// 长文本注入只做布局压力检查，不冒充真实游戏规则覆盖。
async page => {
  const report = { kind: 'sidebar-continuity', url: page.url(), errors: [], failures: [], cases: {} };
  page.on('pageerror', error => report.errors.push(error.message));
  const selectors = ['.game-sidebar', '.scorecard-title', '.players', '#player-1', '#player-0',
    '.ai-avatar', '.human-avatar', '#opponent-name', '#player-0 .player-label strong',
    '#player-1 .player-progress', '#player-0 .player-progress', '#finished-1', '#finished-0',
    '#dots-1', '#dots-0', '.versus-line', '.turn-panel', '.turn-eyebrow', '.turn-content',
    '.turn-copy', '#status-title', '#status-description', '#dice', '#dice-dots', '#roll-button',
    '.button-arrow', '.difficulty-panel', '.difficulty-options', '[data-difficulty="beginner"]',
    '[data-difficulty="medium"]', '[data-difficulty="advanced"]', '[data-difficulty="ultimate"]',
    '.activity-panel', '.activity-panel .section-line', '#activity-list', '#restart-button'];
  const properties = ['display', 'position', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
    'letterSpacing', 'color', 'backgroundColor', 'backgroundImage', 'backgroundSize',
    'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'boxShadow',
    'padding', 'margin', 'gap', 'transform', 'opacity', 'visibility'];
  const check = (condition, message) => { if (!condition) report.failures.push(message); };
  const capture = () => page.evaluate(({ selectors, properties }) => {
    const round = number => Math.round(number * 100) / 100;
    const base = document.querySelector('.game-sidebar').getBoundingClientRect();
    // 大型内嵌纹理仅存摘要，仍可逐状态比较是否换图。
    const summarize = value => value.length < 300 ? value : `hash:${Array.from(value).reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261)};length:${value.length}`;
    const styleOf = (element, pseudo) => {
      const computed = getComputedStyle(element, pseudo);
      return Object.fromEntries([...properties, ...(pseudo ? ['content', 'zIndex', 'inset', 'width', 'height'] : [])]
        .map(property => [property, summarize(computed[property])]));
    };
    const elements = Object.fromEntries(selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const rect = element.getBoundingClientRect();
      return [selector, { rect: { x: round(rect.x - base.x), y: round(rect.y - base.y), width: round(rect.width), height: round(rect.height) },
        style: styleOf(element), before: styleOf(element, '::before'), after: styleOf(element, '::after'),
        text: element.children.length ? undefined : element.textContent, disabled: element.disabled,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }];
    }));
    const sidebar = document.querySelector('.game-sidebar');
    const overlay = ['::before', '::after'].some(pseudo => {
      const style = getComputedStyle(sidebar, pseudo);
      return !['none', 'normal'].includes(style.content) && style.backgroundImage !== 'none' && Number(style.zIndex) > 2;
    });
    return { elements, overlay, viewport: { width: innerWidth, height: innerHeight },
      sidebar: { x: round(base.x), y: round(base.y), width: round(base.width), height: round(base.height) },
      game: LudoGame.snapshot() };
  }, { selectors, properties });
  const compare = (before, after, name, options = {}) => {
    const differences = [];
    for (const selector of selectors) {
      if (options.skip?.includes(selector)) continue;
      const left = before.elements[selector], right = after.elements[selector];
      if (!left || !right) { differences.push(`${selector}: missing`); continue; }
      if (JSON.stringify(left.rect) !== JSON.stringify(right.rect)) differences.push(`${selector}: geometry`);
      if (options.geometryOnly) continue;
      for (const part of ['style', 'before', 'after']) for (const property of Object.keys(left[part])) {
        if (property === 'opacity' && (selector.includes('data-difficulty') || selector === '#restart-button' || selector === '#roll-button')) continue;
        if (options.ignoreSelected && selector.includes('data-difficulty') && ['backgroundColor', 'backgroundImage', 'backgroundSize', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'boxShadow', 'color'].includes(property)) continue;
        if (left[part][property] !== right[part][property]) differences.push(`${selector} ${part}.${property}`);
      }
    }
    check(!after.overlay, `${name}: full-panel foreground image found`);
    check(!differences.length, `${name}: ${differences.join(', ')}`);
    return differences;
  };
  const clearPointer = async () => { await page.mouse.move(1, 1); await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(240); };
  const reset = async () => {
    await page.locator('#restart-button').click();
    await page.locator('#confirm-restart').click();
    await page.waitForFunction(() => !LudoGame.snapshot().started);
    await clearPointer();
  };
  await page.context().setOffline(false);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.getByRole('button', { name: '终极', exact: true }).click();
  await clearPointer();
  await page.evaluate(() => window.scrollTo(0, 0));
  const lobby = await capture();
  report.cases.lobby = lobby;
  check(!lobby.overlay, 'Lobby has a full-panel foreground image');
  await page.screenshot({ path: 'output/playwright/sidebar-before.png' });
  await page.locator('.game-sidebar').screenshot({ path: 'output/playwright/sidebar-before-panel.png' });

  // 从真实 Tab 导航进入侧栏，焦点不能触发换图或位移。
  let reachedFocus = false;
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.id === 'roll-button')) { reachedFocus = true; break; }
  }
  const focused = await capture();
  report.cases.keyboard = { reachedFocus, focusVisible: await page.locator('#roll-button').evaluate(element => element.matches(':focus-visible')),
    differences: compare(lobby, focused, 'Keyboard focus') };
  check(reachedFocus && report.cases.keyboard.focusVisible, 'Keyboard could not reach the start button with visible focus');
  await page.screenshot({ path: 'output/playwright/sidebar-keyboard-focus.png' });
  await clearPointer();

  report.cases.difficulty = [];
  for (const level of ['初级', '中级', '高级', '终极']) {
    await page.getByRole('button', { name: level, exact: true }).click();
    await clearPointer();
    const state = await capture();
    report.cases.difficulty.push({ level, differences: compare(lobby, state, `Difficulty ${level}`, { ignoreSelected: true }) });
  }

  await page.locator('#roll-button').click();
  await page.waitForFunction(() => { const state = LudoGame.snapshot(); return state.started && !state.busy && state.state.activePlayer === 0; }, undefined, { timeout: 30000 });
  await clearPointer();
  await page.evaluate(() => window.scrollTo(0, 0));
  const started = await capture();
  report.cases.started = started;
  report.cases.startDifferences = compare(lobby, started, 'Start game');
  await page.screenshot({ path: 'output/playwright/sidebar-after.png' });
  await page.locator('.game-sidebar').screenshot({ path: 'output/playwright/sidebar-after-panel.png' });

  // 使用项目中的最长常规状态文案，保留按钮、骰盅和日志边界。
  await page.evaluate(async () => {
    const title = document.querySelector('#status-title'), description = document.querySelector('#status-description');
    const label = document.querySelector('#roll-label'), list = document.querySelector('#activity-list');
    window.__sidebarSavedContent = { title: title.textContent, description: description.textContent, label: label.textContent, log: list.innerHTML,
      compactTitle: title.classList.contains('compact-title'), compactLabel: document.querySelector('#roll-button').classList.contains('compact-label') };
    title.textContent = '再掷一次，继续出发';
    description.textContent = '掷出了 6 点，点击带箭头和外圈的红色棋子。';
    label.textContent = '点击带箭头的红色棋子';
    title.classList.toggle('compact-title', title.textContent.length > 7);
    document.querySelector('#roll-button').classList.toggle('compact-label', label.textContent.length > 7);
    list.replaceChildren(...Array.from({ length: 12 }, (_, index) => {
      const item = document.createElement('li'), dot = document.createElement('span'), text = document.createElement('span');
      dot.className = 'log-dot red'; text.textContent = `第 ${index + 1} 步：你的棋子安全抵达目的地，获得一次再掷机会。`;
      item.append(dot, text); return item;
    }));
    // 先触发布局，使新汉字和字号对应的字体加载被浏览器登记，再等待字体就绪。
    title.getBoundingClientRect();
    label.getBoundingClientRect();
    await Promise.all([title, label].map(element => {
      const font = getComputedStyle(element);
      return document.fonts.load(`${font.fontWeight} ${font.fontSize} ${font.fontFamily}`, element.textContent);
    }));
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
  });
  await page.waitForTimeout(80);
  report.cases.longContent = await page.evaluate(() => {
    const title = document.querySelector('#status-title'), description = document.querySelector('#status-description');
    const label = document.querySelector('#roll-label'), list = document.querySelector('#activity-list');
    const rect = element => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height, bottom: value.bottom, right: value.right }; };
    const titleRect = rect(title), descriptionRect = rect(description), buttonRect = rect(document.querySelector('#roll-button'));
    const copyRect = rect(document.querySelector('.turn-copy')), diceRect = rect(document.querySelector('#dice'));
    const range = document.createRange(); range.selectNodeContents(label); const labelRect = range.getBoundingClientRect();
    return { title: titleRect, description: descriptionRect, button: buttonRect, copy: copyRect, dice: diceRect,
      titleFont: getComputedStyle(title).font, titleClass: title.className, labelFont: getComputedStyle(label).font,
      label: { x: labelRect.x, right: labelRect.right, bottom: labelRect.bottom, width: labelRect.width },
      textBeforeButton: descriptionRect.bottom <= buttonRect.y,
      noDiceOverlap: copyRect.right <= diceRect.x || copyRect.bottom <= diceRect.y,
      labelFits: labelRect.x >= buttonRect.x && labelRect.right <= buttonRect.right && labelRect.bottom <= buttonRect.bottom,
      logScrolls: list.scrollHeight > list.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(list).overflowY) };
  });
  const stress = await capture();
  report.cases.longContent.differences = compare(started, stress, 'Long content layout', { geometryOnly: true, skip: ['#status-title', '#status-description', '.turn-copy', '.button-arrow'] });
  for (const key of ['textBeforeButton', 'noDiceOverlap', 'labelFits', 'logScrolls']) check(report.cases.longContent[key], `Long content: ${key}`);
  await page.screenshot({ path: 'output/playwright/sidebar-long-content.png' });
  await page.evaluate(() => {
    const saved = window.__sidebarSavedContent;
    document.querySelector('#status-title').textContent = saved.title;
    document.querySelector('#status-description').textContent = saved.description;
    document.querySelector('#roll-label').textContent = saved.label;
    document.querySelector('#status-title').classList.toggle('compact-title', saved.compactTitle);
    document.querySelector('#roll-button').classList.toggle('compact-label', saved.compactLabel);
    document.querySelector('#activity-list').innerHTML = saved.log;
    delete window.__sidebarSavedContent;
  });

  // 掷骰允许骰子本身旋转，但骰子布局锚点和周边操作区必须保持固定。
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  report.cases.animation = await page.evaluate(async () => {
    const dice = document.querySelector('#dice');
    const button = document.querySelector('#roll-button');
    const skinProperties = ['backgroundImage', 'backgroundSize', 'backgroundBlendMode', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'boxShadow'];
    const skin = () => Object.fromEntries(skinProperties.map(property => [property, getComputedStyle(button)[property]]).concat(
      ['borderTop', 'borderRadius', 'inset', 'content'].map(property => [`before.${property}`, getComputedStyle(button, '::before')[property]])));
    const idleSkin = skin();
    const textureDifferences = new Set();
    const anchors = () => [dice.offsetLeft, dice.offsetTop, dice.offsetWidth, dice.offsetHeight,
      document.querySelector('#roll-button').offsetTop, document.querySelector('.difficulty-panel').offsetTop,
      document.querySelector('.turn-content').getBoundingClientRect().width];
    const baseline = anchors(); const transforms = new Set(); let frames = 0;
    document.querySelector('#roll-button').click();
    const deadline = performance.now() + 3000;
    while (LudoGame.snapshot().activity === 'rolling' && performance.now() < deadline) {
      if (JSON.stringify(anchors()) !== JSON.stringify(baseline)) return { stable: false, baseline, during: anchors() };
      const busySkin = skin();
      for (const property of Object.keys(idleSkin)) if (busySkin[property] !== idleSkin[property]) textureDifferences.add(property);
      transforms.add(getComputedStyle(dice).transform); frames++;
      await new Promise(requestAnimationFrame);
    }
    return { stable: true, frames, transformSamples: transforms.size, finished: !dice.classList.contains('rolling'),
      busyTexturePresent: idleSkin.backgroundImage.includes('data:'), busyTextureDifferences: [...textureDifferences] };
  });
  check(report.cases.animation.stable && report.cases.animation.frames > 0 && report.cases.animation.transformSamples > 1 && report.cases.animation.finished, 'Dice animation moved its layout anchor or was not observed');
  check(report.cases.animation.busyTexturePresent && !report.cases.animation.busyTextureDifferences?.length, `Busy roll button lost texture or frame: ${report.cases.animation.busyTextureDifferences?.join(', ')}`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await reset();
  const resetState = await capture();
  report.cases.restart = { differences: compare(lobby, resetState, 'Restart'), game: resetState.game };
  check(!resetState.game.started && !resetState.game.busy && resetState.game.rollCount === 0, 'Restart did not restore lobby state');
  await page.screenshot({ path: 'output/playwright/sidebar-restarted.png' });

  // 小桌面允许横向滚动，检查操作按钮能实际滚入视口并被点击。
  report.cases.reachability = [];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await page.getByRole('button', { name: '初级', exact: true }).click();
    await page.locator('#roll-button').scrollIntoViewIfNeeded();
    await page.locator('#roll-button').click();
    await page.waitForFunction(() => LudoGame.snapshot().started);
    // 现有移动端 arrive 动画带 130ms 延时，等待首帧绘制后再记录可见性证据。
    await page.waitForTimeout(250);
    const restartSelector = viewport.width <= 780 ? '#mobile-restart' : '#restart-button';
    await page.locator(restartSelector).scrollIntoViewIfNeeded();
    const box = await page.locator(restartSelector).boundingBox();
    const accessible = box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1;
    const dockBox = await page.locator('#turn-panel').boundingBox();
    if (viewport.width <= 780) check(dockBox.y >= 0 && dockBox.y + dockBox.height <= viewport.height, 'Mobile turn controls are clipped');
    check(accessible, `${viewport.width}px restart is clipped after scrolling`);
    await page.screenshot({ path: `output/playwright/sidebar-${viewport.width}-playing.png` });
    await page.locator(restartSelector).click();
    await page.locator('#confirm-restart').click();
    await page.waitForFunction(() => !LudoGame.snapshot().started);
    report.cases.reachability.push({ viewport, accessible, restartBox: box, dockBox, restoredLobby: true });
  }
  check(!report.errors.length, `Page errors: ${report.errors.join('; ')}`);
  report.status = report.failures.length ? 'failed' : 'passed';
  await page.evaluate(value => { window.__ludoSidebarReport = value; }, report);
  return { status: report.status, failures: report.failures, errors: report.errors, animation: report.cases.animation,
    reachability: report.cases.reachability, artifacts: 'output/playwright/sidebar-*.png', report: 'window.__ludoSidebarReport' };
}
