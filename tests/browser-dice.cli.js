// 骰子时序回归：真实随机骰点，逐帧检查玩家和电脑的结果公布时机。
async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cases = [];
  for (const mode of ['normal', 'extended', 'reduced']) {
    await page.emulateMedia({ reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    await page.reload();
    if (mode === 'extended') {
      // 故意拉长动画，验证代码等待实际结束，而非固定的 510ms。
      await page.addStyleTag({ content: '.dice.rolling{animation-duration:1.2s!important}' });
    }
    const result = await page.evaluate(async mode => {
      const dice = document.querySelector('#dice');
      const log = document.querySelector('#activity-list');
      const completed = [];
      let rolling = null;
      const frame = () => new Promise(requestAnimationFrame);
      const observe = () => {
        const snapshot = LudoGame.snapshot();
        if (snapshot.error) throw new Error(snapshot.error);
        if (snapshot.activity === 'rolling') {
          if (!rolling) {
            const animation = dice.getAnimations().find(item => item.animationName === 'dice-roll');
            if (!animation) throw new Error('Missing dice animation');
            rolling = { previousFace: snapshot.lastDie, rollCount: snapshot.rollCount,
              state: JSON.stringify(snapshot.state), text: log.textContent,
              animation, finished: false, frames: 0, duration: animation.effect.getTiming().duration };
            // 公布结果会移除 rolling class，使已完成的 CSSAnimation 变回 idle。
            const observedRoll = rolling;
            animation.finished.then(() => { observedRoll.finished = true; }, () => {});
          }
          if (document.querySelectorAll('#dice-dots .visible').length ||
              dice.getAttribute('aria-label') !== '正在掷骰，等待结果' ||
              dice.getAttribute('aria-busy') !== 'true' ||
              document.querySelectorAll('.token.legal').length ||
              !document.querySelector('#roll-button').disabled ||
              snapshot.lastDie !== rolling.previousFace || log.textContent !== rolling.text) {
            throw new Error('Result or legal moves exposed during rolling');
          }
          rolling.frames++;
        } else if (rolling) {
          if (!rolling.finished) throw new Error('Result exposed before animation finished');
          if (snapshot.rollCount !== rolling.rollCount || JSON.stringify(snapshot.state) !== rolling.state) {
            throw new Error('Result reveal changed the committed roll');
          }
          if (snapshot.lastDie < 1 || snapshot.lastDie > 6 ||
              document.querySelectorAll('#dice-dots .visible').length !== snapshot.lastDie ||
              dice.getAttribute('aria-label') !== `骰子 ${snapshot.lastDie} 点` ||
              dice.getAttribute('aria-busy') !== 'false' || dice.classList.contains('rolling')) {
            throw new Error('Final face was not revealed correctly');
          }
          const actor = log.firstElementChild.textContent.startsWith('你') ? 0 : 1;
          completed.push({ actor, die: snapshot.lastDie, frames: rolling.frames, duration: rolling.duration });
          rolling = null;
        }
        return snapshot;
      };
      document.querySelector('#roll-button').click();
      const deadline = performance.now() + 30000;
      while (performance.now() < deadline) {
        let snapshot = observe();
        if (new Set(completed.map(roll => roll.actor)).size === 2) return {mode, completed};
        if (!snapshot.busy && snapshot.state.activePlayer === 0) {
          if (snapshot.state.phase === 'awaitingRoll') document.querySelector('#roll-button').click();
          else document.querySelector('.token.red.legal')?.click();
          // 捕捉减少动画模式在下一帧之前就会结束的动画。
          observe();
        }
        await frame();
      }
      throw new Error('Missing player or computer roll sample: '+JSON.stringify(completed));
    }, mode);
    cases.push(result);
  }

  // 合成页面生命周期用于验证已生成的骰点只揭示一次，不代表真实 BFCache 覆盖。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.locator('#roll-button').click();
  await page.waitForFunction(() => { const s=LudoGame.snapshot(); return !s.busy && s.state.activePlayer===0; });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const recovery = await page.evaluate(() => {
    const before = LudoGame.snapshot();
    document.querySelector('#roll-button').click();
    const during = LudoGame.snapshot();
    if (!during.busy || during.activity !== 'rolling') throw new Error('No roll to recover');
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
    const after = LudoGame.snapshot();
    if (after.busy || after.rollCount !== before.rollCount+1 || JSON.stringify(after.state)!==JSON.stringify(during.state) ||
        document.querySelector('#dice').getAttribute('aria-label')!==`骰子 ${after.lastDie} 点`) throw new Error('Roll recovery failed');
    document.querySelector('#restart-button').click();
    document.querySelector('#confirm-restart').click();
    return {rollCommittedOnce:true, resultRevealed:true};
  });
  await page.waitForTimeout(700);
  if (await page.evaluate(() => {const s=LudoGame.snapshot(); return s.started || s.busy || s.lastDie!==null;})) throw new Error('Old roll polluted reset');

  // 在动画中重开，再等待旧动画的 Promise 结束。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#roll-button').click();
  await page.waitForFunction(() => {const s=LudoGame.snapshot(); return !s.busy && s.state.activePlayer===0;});
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    document.querySelector('#roll-button').click();
    if (LudoGame.snapshot().activity!=='rolling') throw new Error('No roll to cancel');
    document.querySelector('#restart-button').click();
    document.querySelector('#confirm-restart').click();
  });
  await page.waitForTimeout(700);
  if (await page.evaluate(() => {const s=LudoGame.snapshot(); return s.started || s.busy || s.rollCount || s.lastDie!==null;})) throw new Error('Cancelled roll polluted reset');
  if (errors.length) throw new Error(JSON.stringify(errors));
  await page.evaluate(report => {window.__ludoDiceReport=report;}, {cases,recovery,restartDuringRoll:true,errors});
}
