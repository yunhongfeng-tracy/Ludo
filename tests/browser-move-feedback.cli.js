// Playwright CLI 验收。罕见局面只在路由返回的验收 HTML 中注入，生产页面没有可写棋局接口。
// 棋规、走棋入口、吃子结算与奖励均执行成品中的原函数。幽灵截图只暂停原生动画时间轴。
async page => {
  const report = { kind: 'move-feedback', status: 'running', url: page.url(), errors: [], cases: {},
    limits: ['390px 为 Chromium 窄视口，并非手机真机', '罕见局面由测试专用 HTML 设定，页面生命周期使用合成事件'] };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const baseUrl = page.url().split('#')[0];
  const artifact = () => page.evaluate(async () => {
    const bytes = await (await fetch(location.href, { cache: 'no-store' })).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return { sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''), bytes: bytes.byteLength };
  });
  report.artifact = await artifact();
  page.on('pageerror', error => report.errors.push(error.message));
  let fixture = null;
  const intercept = async route => {
    if (!fixture || !route.request().isNavigationRequest()) return route.continue();
    const response = await route.fetch();
    const html = await response.text();
    const boundary = '/* 网页控制器：';
    check(html.includes(boundary), '无法定位仅验收 HTML 的控制器边界');
    const injection = `\n(function(){
      const E=window.LudoEngine, fixture=${JSON.stringify(fixture)};
      const audit=window.__moveFixture={fixture,createCalls:0,actions:[],sound:[]};
      window.LudoEngine={...E,
        createGame(player){
          audit.createCalls++;
          if(audit.createCalls!==2)return E.createGame(player);
          const initial=E.createGame(fixture.player);
          initial.tokenProgress=fixture.tokens.map(side=>side.slice());
          const state=E.applyRoll(initial,fixture.die);
          audit.before=E.cloneState(state);audit.expected=E.applyAction(state,fixture.token);
          return state;
        },
        applyAction(state,token){
          const result=E.applyAction(state,token);
          audit.actions.push({token,before:E.cloneState(state),after:E.cloneState(result)});
          return result;
        }
      };
      const S=window.LudoSound;
      window.LudoSound={...S,create(...args){const instance=S.create(...args);return {...instance,play(kind,options){audit.sound.push(kind);return instance.play(kind,options);}};}};
    })();\n`;
    await route.fulfill({ response, body: html.replace(boundary, injection + boundary) });
  };
  await page.route('**/*', intercept);

  const read = () => page.evaluate(() => {
    const game = LudoGame.snapshot(), stage = document.querySelector('#board-stage').getBoundingClientRect();
    const rect = element => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        cx: bounds.x + bounds.width / 2, cy: bounds.y + bounds.height / 2 };
    };
    const marker = document.querySelector('#last-move-layer .move-destination');
    const original = window.__moveFixture?.before;
    const token = window.__moveFixture?.fixture.token;
    const player = original?.activePlayer;
    const position = original ? LudoEngine.position(player, game.state.tokenProgress[player][token]) : null;
    const safe = element => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return { rect: rect(element), pointerEvents: style.pointerEvents, visibility: style.visibility,
        display: style.display, opacity: style.opacity, attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
        parentAttributes: Object.fromEntries([...element.parentElement.attributes].map(attribute => [attribute.name, attribute.value])) };
    };
    return { game, feedback: document.querySelector('#move-feedback')?.textContent.trim(),
      feedbackVisible: document.querySelector('#move-feedback') ? getComputedStyle(document.querySelector('#move-feedback')).display !== 'none' && !document.querySelector('#move-feedback').hidden : false,
      feedbackKind: document.querySelector('#move-feedback')?.dataset.kind,
      status: document.querySelector('#status-description').textContent,
      logs: [...document.querySelectorAll('#activity-list li')].map(element => element.textContent.trim()),
      ghosts: [...document.querySelectorAll('.capture-ghost')].map(safe), marker: safe(marker),
      expectedCell: position ? { ...position, x: stage.x + (position.col + .5) * stage.width / 15,
        y: stage.y + (position.row + .5) * stage.height / 15 } : null,
      audit: window.__moveFixture || null,
      finished: [...document.querySelectorAll('[id^="finished-"]')].map(element => element.textContent),
      lastTokens: [...document.querySelectorAll('.token.last-moved')].map(element => element.id) };
  });
  const load = async (selected, viewport = { width: 1536, height: 1024 }, reduced = false) => {
    fixture = selected;
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.LudoGame && document.querySelector('#move-feedback'));
    await page.locator('[data-difficulty="beginner"]').click();
    await page.locator('#roll-button').click();
    await page.waitForFunction(() => LudoGame.snapshot().started && document.body.classList.contains('playing'));
    await page.evaluate(() => window.scrollTo(0, 0));
  };
  const clickMove = async selected => {
    if (selected.player === 0) await page.locator(`#token-0-${selected.token}`).click();
    await page.waitForFunction(() => __moveFixture.actions.length > 0);
  };
  const waitSettled = () => page.waitForFunction(() => !LudoGame.snapshot().busy && __moveFixture.actions.length > 0);
  const validate = (sample, selected, words) => {
    check(!sample.game.error, `${selected.name}: ${sample.game.error}`);
    check(JSON.stringify(sample.game.state) === JSON.stringify(sample.audit.expected), `${selected.name}: 页面结算偏离原棋规`);
    check(sample.audit.actions.length === 1, `${selected.name}: 一步被结算多次`);
    check(sample.game.rollCount === 0 && sample.game.lastDie === null, `${selected.name}: 走棋反馈额外掷骰`);
    check(sample.ghosts.length === 0, `${selected.name}: 回营后仍有幽灵`);
    check(sample.feedbackVisible && words.every(word => sample.feedback.includes(word)), `${selected.name}: 反馈不完整 ${sample.feedback}`);
    check(sample.marker && sample.marker.attributes['data-cell-id'] === sample.expectedCell.cellId, `${selected.name}: 落点与棋规不一致`);
    check(sample.marker.parentAttributes['data-player'] === String(selected.player) && sample.marker.parentAttributes['data-token'] === String(selected.token), `${selected.name}: 落点身份不一致`);
    check(Math.hypot(sample.marker.rect.cx - sample.expectedCell.x, sample.marker.rect.cy - sample.expectedCell.y) < 1,
      `${selected.name}: 落点没有覆盖实际格心`);
    check(sample.marker.pointerEvents === 'none', `${selected.name}: 落点标记拦截点击`);
    check(sample.lastTokens.includes(`token-${selected.player}-${selected.token}`), `${selected.name}: 未标出最后走动的棋子`);
  };

  const layouts = {
    ordinary: { name: 'red-ordinary', player: 0, token: 3, tokens: [[-1, -1, -1, 3], [-1, -1, -1, -1]], die: 2 },
    safe: { name: 'red4-yellow4-safe-ring8', player: 0, token: 3, tokens: [[-1, -1, -1, 7], [-1, -1, -1, 34]], die: 1 },
    capture: { name: 'red4-captures-yellow4-ring7', player: 0, token: 3, tokens: [[-1, -1, -1, 6], [-1, -1, -1, 33]], die: 1 },
    slowCapture: { name: 'red4-six-step-capture', player: 0, token: 3, tokens: [[-1, -1, -1, 1], [-1, -1, -1, 33]], die: 6 },
    multiple: { name: 'red4-captures-yellow2-and4', player: 0, token: 3, tokens: [[-1, -1, -1, 6], [-1, 33, -1, 33]], die: 1 },
    finish: { name: 'red4-home', player: 0, token: 3, tokens: [[-1, -1, -1, 55], [-1, -1, -1, -1]], die: 1 },
    computer: { name: 'computer-yellow4-ordinary', player: 1, token: 3, tokens: [[-1, -1, -1, -1], [-1, -1, -1, 3]], die: 2 },
    computerSafe: { name: 'computer-yellow4-red4-safe-ring34', player: 1, token: 3, tokens: [[-1, -1, -1, 34], [-1, -1, -1, 7]], die: 1 },
    computerCapture: { name: 'computer-yellow4-captures-red4', player: 1, token: 3, tokens: [[-1, -1, -1, 33], [-1, -1, -1, 6]], die: 1 }
  };
  try {
    // 未修改 HTML 的真实开局，只比较第一步前的所有棋子与底图。
    fixture = null;
    await page.setViewportSize({ width: 1536, height: 1024 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(baseUrl);
    const appearance = () => page.evaluate(() => {
      const fingerprint = value => {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
        return `${value.length}:${(hash >>> 0).toString(16)}`;
      };
      const effectiveOpacity = element => {
        let opacity = 1;
        for (let node = element; node instanceof Element; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
        return opacity;
      };
      const tokens = [...document.querySelectorAll('#token-layer .token')].map(element => {
        const style = getComputedStyle(element), face = getComputedStyle(element.querySelector('.token-face')), rect = element.getBoundingClientRect();
        return { id: element.id, width: rect.width, height: rect.height, x: rect.x, y: rect.y,
          opacity: effectiveOpacity(element), visibility: style.visibility, texture: fingerprint(style.backgroundImage),
          faceTexture: fingerprint(face.backgroundImage), font: face.font, shadow: style.boxShadow };
      });
      return { tokens, boardTexture: fingerprint(getComputedStyle(document.querySelector('.board-art')).backgroundImage),
        stageTexture: fingerprint(getComputedStyle(document.querySelector('.board-stage')).backgroundImage) };
    });
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const before = await appearance();
    await page.screenshot({ path: 'output/playwright/move-feedback-lobby.png', fullPage: true });
    await page.locator('[data-difficulty="beginner"]').click();
    await page.locator('#roll-button').click();
    await page.waitForFunction(() => document.body.classList.contains('playing'));
    const after = await appearance();
    check(before.tokens.length === 8 && after.tokens.length === 8, '开局前后不都是 8 枚真实棋子');
    check(before.boardTexture === after.boardTexture && before.stageTexture === after.stageTexture, '开局切换了棋盘底图');
    for (const initial of before.tokens) {
      const current = after.tokens.find(token => token.id === initial.id);
      check(initial.opacity > .98 && current.opacity > .98 && initial.visibility === 'visible' && current.visibility === 'visible', `${initial.id}: 开局前后的实际棋子不可见`);
      check(Math.abs(initial.width - current.width) < .75 && Math.abs(initial.height - current.height) < .75 && Math.hypot(initial.x - current.x, initial.y - current.y) < .75, `${initial.id}: 开局后大小或位置改变`);
      check(initial.texture === current.texture && initial.faceTexture === current.faceTexture && initial.font === current.font && initial.shadow === current.shadow, `${initial.id}: 开局后材质改变`);
    }
    report.cases.appearance = { before, after, realUnmodifiedStart: true };
    await page.screenshot({ path: 'output/playwright/move-feedback-started.png', fullPage: true });

    for (const [name, words] of [['ordinary', ['红4', '2']], ['safe', ['红4', '黄4', '安全', '共存']], ['finish', ['红4', '到家']], ['computer', ['黄4', '2']], ['computerSafe', ['红4', '黄4', '安全', '共存']]]) {
      const selected = layouts[name];
      await load(selected);
      await clickMove(selected);
      await waitSettled();
      const result = await read();
      validate(result, selected, words);
      if (name === 'safe') {
        check(result.game.state.tokenProgress[1][3] === 34 && result.game.captureCount === 0, '安全格共存意外吃子');
        await page.screenshot({ path: 'output/playwright/move-feedback-safe-desktop.png', fullPage: true });
      }
      if (name === 'finish') check(result.status.includes('再掷') && result.game.state.activePlayer === 0, '到家反馈覆盖或取消了奖励');
      report.cases[name] = result;
    }

    for (const name of ['capture', 'multiple', 'computerCapture']) {
      const selected = layouts[name];
      await load(selected);
      await clickMove(selected);
      await page.waitForFunction(() => document.querySelectorAll('.capture-ghost').length > 0);
      const frames = await page.evaluate(() => {
        const ghosts = [...document.querySelectorAll('.capture-ghost')];
        const rect = element => { const r = element.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, cx:r.x+r.width/2, cy:r.y+r.height/2 }; };
        window.__captureAnimations = ghosts.flatMap(ghost => ghost.getAnimations());
        return ghosts.map(ghost => {
          const animations = ghost.getAnimations();
          if (!animations.length) throw Error('吃子幽灵没有实际 Web Animation');
          const animation = animations[0], duration = animation.effect.getComputedTiming().activeDuration;
          animation.pause(); animation.currentTime = 0;
          const start = rect(ghost);
          animation.currentTime = duration * .5;
          const middle = rect(ghost);
          // 90% 后只退场不再位移，避开恰好 finished 触发生产完成回调。
          animation.currentTime = duration * .95;
          const end = rect(ghost);
          animation.currentTime = duration * .5;
          return { start, middle, end, duration, keyframes: animation.effect.getKeyframes(),
            dataset: {...ghost.dataset}, pointerEvents: getComputedStyle(ghost).pointerEvents,
            hitTarget: document.elementFromPoint(middle.cx, middle.cy)?.closest('.capture-ghost')?.className || null };
        });
      });
      check(frames.length === (name === 'multiple' ? 2 : 1), `${name}: 回营动画棋子数量不符`);
      for (const frame of frames) {
        check(frame.duration > 100 && frame.keyframes.length >= 2, `${name}: 缺少可见回营过程`);
        check(Math.hypot(frame.start.cx - frame.end.cx, frame.start.cy - frame.end.cy) > 50 && Math.hypot(frame.middle.cx - frame.start.cx, frame.middle.cy - frame.start.cy) > 10, `${name}: 幽灵没有实际移动`);
        check(frame.pointerEvents === 'none' && !frame.hitTarget, `${name}: 幽灵挡住棋盘点击`);
      }
      await page.screenshot({ path: `output/playwright/move-feedback-${name}-returning.png`, fullPage: true });
      await page.evaluate(() => __captureAnimations.forEach(animation => animation.finish()));
      await waitSettled();
      const result = await read();
      const words = name === 'multiple' ? ['红4', '黄2', '黄4', '回'] : ['红4', '黄4', '回'];
      validate(result, selected, words);
      check(result.status.includes('再掷') && result.game.state.activePlayer === selected.player && result.game.captureCount === 1, `${name}: 吃子奖励发生改变`);
      check(result.audit.sound.filter(kind => kind === 'capture').length === 1, `${name}: 吃子音效没有恰好触发一次`);
      const captured = result.audit.before.tokenProgress[1-selected.player].map((progress, index) => ({progress, index})).filter(({progress,index}) => progress >= 0 && result.game.state.tokenProgress[1-selected.player][index] === -1);
      const yards = await page.evaluate(({player, captured}) => captured.map(({index}) => {
        const r = document.getElementById(`token-${1-player}-${index}`).getBoundingClientRect();
        return {token: index, cx:r.x+r.width/2, cy:r.y+r.height/2};
      }), {player:selected.player, captured});
      report.cases[name] = { ...result, frames, yards };
      for (const frame of frames) check(yards.some(yard => Math.hypot(yard.cx-frame.end.cx,yard.cy-frame.end.cy)<1), `${name}: 回营终点没有对准被吃棋子的基地 ${JSON.stringify({end:frame.end,yards})}`);
    }

    for (const action of ['restart', 'updates', 'pagehide']) {
      await load(layouts.capture);
      await clickMove(layouts.capture);
      await page.waitForFunction(() => document.querySelector('.capture-ghost'));
      if (action === 'restart') {
        await page.locator('#restart-button').click();
        await page.locator('#confirm-restart').click();
      } else if (action === 'updates') await page.locator('.updates-link').click();
      else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      await page.waitForTimeout(40);
      const stopped = await read();
      check(stopped.ghosts.length === 0, `${action}: 离开时没有移除回营幽灵`);
      if (action === 'updates') await page.locator('.back-to-game').click();
      if (action === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await page.waitForTimeout(750);
      const returned = await read();
      check(returned.ghosts.length === 0 && returned.audit.actions.length === 1, `${action}: 返回后重播或重复结算`);
      check(returned.audit.sound.filter(kind => kind === 'capture').length <= 1, `${action}: 重复播放吃子结算声音`);
      if (action === 'restart') check(!returned.game.started && !returned.marker && !returned.game.lastMove && returned.feedbackKind === 'ready' && !returned.feedback.includes('红4'), '重开残留上局落点或反馈');
      else validate(returned, layouts.capture, ['红4', '黄4', '回']);
      report.cases[action] = { stopped, returned };
    }

    // 在前进阶段切换到更新页，后续回营区域已经无尺寸，仍应结算一次而不产生零坐标幽灵。
    await load(layouts.slowCapture);
    await clickMove(layouts.slowCapture);
    const beforeMovingLeave = await read();
    check(beforeMovingLeave.game.activity === 'moving' && beforeMovingLeave.ghosts.length === 0, '没有覆盖前进阶段离页的窗口');
    await page.locator('.updates-link').click();
    await waitSettled();
    const hiddenSettlement = await read();
    check(hiddenSettlement.game.viewingUpdates && hiddenSettlement.ghosts.length === 0 && !hiddenSettlement.game.error, '更新页中的后续吃子产生幽灵或异常');
    await page.locator('.back-to-game').click();
    const afterMovingLeave = await read();
    validate(afterMovingLeave, layouts.slowCapture, ['红4', '黄4', '回']);
    check(afterMovingLeave.game.captureCount === 1 && afterMovingLeave.game.state.activePlayer === 0 && afterMovingLeave.game.state.consecutiveSixes === 1, '掷 6 与吃子奖励叠加或丢失');
    report.cases.updatesWhileMoving = { before: beforeMovingLeave, hidden: hiddenSettlement, returned: afterMovingLeave };

    await load(layouts.safe, { width: 390, height: 844 });
    // 等待旧入场动画原本会完成的时间，不以临时样式绕过真实 fixed 包含块。
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    const mobileLayout = () => page.evaluate(() => {
      const panel = document.querySelector('.turn-panel'), feedback = document.querySelector('#move-feedback');
      const bounds = panel.getBoundingClientRect(), feedbackBounds = feedback.getBoundingClientRect();
      const style = getComputedStyle(panel), sidebarStyle = getComputedStyle(document.querySelector('.game-sidebar'));
      return { viewportHeight: innerHeight, scrollY, panel: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
        feedback: { top: feedbackBounds.top, bottom: feedbackBounds.bottom }, position: style.position,
        backgroundColor: style.backgroundColor, opacity: style.opacity, sidebarTransform: sidebarStyle.transform,
        actionHit: document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 20)?.closest('.turn-panel') === panel };
    });
    const validateMobileLayout = layout => {
      check(layout.scrollY === 0 && layout.position === 'fixed' && layout.panel.top >= 0 && layout.panel.bottom <= layout.viewportHeight,
        `手机固定操作栏超出初始视口: ${JSON.stringify(layout)}`);
      check(layout.feedback.bottom < layout.panel.top, '手机操作栏遮挡了新行动反馈');
      check(layout.backgroundColor.startsWith('rgb(') && layout.opacity === '1', '手机操作栏纸面底色不透明');
      check(layout.sidebarTransform === 'none' && layout.actionHit, '手机操作栏仍受侧栏变换影响或无法命中');
    };
    const mobileBeforeMove = await mobileLayout();
    validateMobileLayout(mobileBeforeMove);
    await clickMove(layouts.safe);
    await waitSettled();
    const mobile = await read();
    validate(mobile, layouts.safe, ['红4', '黄4', '安全', '共存']);
    const mobileAfterMove = await mobileLayout();
    validateMobileLayout(mobileAfterMove);
    await page.screenshot({ path: 'output/playwright/move-feedback-safe-mobile-viewport.png' });
    await page.screenshot({ path: 'output/playwright/move-feedback-safe-mobile.png', fullPage: true });
    report.cases.mobile = { ...mobile, beforeMoveLayout: mobileBeforeMove, afterMoveLayout: mobileAfterMove };
    await load(layouts.capture, { width: 390, height: 844 }, true);
    await clickMove(layouts.capture);
    await waitSettled();
    const reduced = await read();
    validate(reduced, layouts.capture, ['红4', '黄4', '回']);
    report.cases.reducedMotion = reduced;
    check(report.errors.length === 0, `页面异常: ${JSON.stringify(report.errors)}`);
    report.finalArtifact = await artifact();
    check(report.artifact.sha256 === report.finalArtifact.sha256, '验收期间成品发生变化，应重新验收最终构建');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); }
  finally { await page.unroute('**/*', intercept); }
  await page.evaluate(value => { window.__ludoMoveFeedbackReport = value; }, report);
  console.log(JSON.stringify({ status: report.status, cases: Object.keys(report.cases), failure: report.failure, artifact: report.artifact }));
  if (report.status !== 'passed') throw new Error(report.failure);
}
