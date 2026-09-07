// 通过真实按钮完成对局，核对人类玩家吃子与到家后的奖励提示及页面返回。
async (page) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const report = window.__bonusReport = { status: 'running', startedAt: new Date().toISOString(), rulesetId: LudoEngine.RULESET_ID, checks: [], games: [], errors: [] };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    window.__bonusTask = (async () => {
      if (LudoGame.snapshot().viewingUpdates) document.querySelector('.back-to-game').click();
      assert(!LudoGame.snapshot().started, 'Test must start in lobby');
      assert(report.rulesetId === 'basic-ludo-1v1@2', 'Old rules loaded');
      for (let game = 0; game < 3; game++) {
        document.querySelector('[data-difficulty="medium"]').click();
        document.getElementById('roll-button').click();
        const deadline = performance.now() + 160000;
        while (true) {
          const snapshot = LudoGame.snapshot(), state = snapshot.state;
          assert(!snapshot.error, snapshot.error);
          assert(performance.now() < deadline, 'Game timed out');
          if (snapshot.busy) { await wait(8); continue; }
          if (state.phase === 'finished') {
            report.games.push({ rolls: snapshot.rollCount, winner: state.winner });
            document.getElementById('play-again').click();
            break;
          }
          if (state.activePlayer === 0 && state.phase === 'awaitingRoll') document.getElementById('roll-button').click();
          if (state.activePlayer === 0 && state.phase === 'awaitingMove') {
            const action = LudoAI.chooseAction(state, 'medium').action;
            const expected = LudoEngine.applyAction(state, action);
            const capture = state.tokenProgress[1].some((p, i) => p >= 0 && expected.tokenProgress[1][i] === -1);
            const home = expected.tokenProgress[0][action] === LudoEngine.FINISH;
            document.querySelectorAll('.token.red')[action].click();
            while (LudoGame.snapshot().busy) await wait(4);
            const after = LudoGame.snapshot();
            assert(JSON.stringify(after.state) === JSON.stringify(expected), 'UI result differs from rules');
            if ((capture || home) && expected.phase !== 'finished') {
              const description = document.getElementById('status-description').textContent;
              assert(after.state.activePlayer === 0 && !document.getElementById('roll-button').disabled, 'Reward did not enable another roll');
              assert(description.includes(capture ? '吃掉' : 'HOME') && description.includes('再掷'), 'Missing reward explanation');
              document.querySelector('.site-footer [data-updates-link]').click();
              await wait(10);
              document.querySelector('.back-to-game').click();
              await wait(10);
              assert(JSON.stringify(LudoGame.snapshot().state) === JSON.stringify(expected), 'Reward lost on page return');
              assert(document.getElementById('status-description').textContent === description, 'Reward explanation lost');
              report.checks.push({ capture, home, die: state.pendingDie, preserved: true });
            }
          }
          await wait(8);
        }
        if (report.checks.some(c => c.capture) && report.checks.some(c => c.home)) break;
      }
      assert(report.checks.some(c => c.capture) && report.checks.some(c => c.home), 'Random games did not cover both rewards');
      assert(!document.getElementById('status-description').textContent.includes('再掷'), 'Restart retained reward');
      report.status = 'passed'; report.completedAt = new Date().toISOString();
    })().catch(error => { report.status = 'failed'; report.errors.push(String(error.stack || error)); });
  });
}
