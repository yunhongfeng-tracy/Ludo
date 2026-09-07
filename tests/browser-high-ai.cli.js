// 本地单文件或正式页面加载后断网，验证两档搜索的整局、Worker耗时与重开取消。
async (page) => {
  const errors = [], network = [];
  const localFile = page.url().startsWith('file:');
  let loaded = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if ((localFile || loaded) && /^https?:/.test(request.url())) network.push(request.url()); });
  await page.context().setOffline(localFile);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.reload();
  await page.context().setOffline(true); loaded = true;
  await page.evaluate(() => {
    window.__aiLongTasks=[];
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      const observer = new PerformanceObserver(list => {
        window.__aiLongTasks.push(...list.getEntries().map(entry=>({start:entry.startTime,duration:entry.duration})));
      });
      observer.observe({type:'longtask'});
    }
  });
  const games = [], decisions = [], seen = new Set();
  for (const difficulty of ['advanced','ultimate']) {
    await page.locator(`[data-difficulty="${difficulty}"]`).click();
    await page.locator('#roll-button').click();
    let finalState;
    for (let step=0;step<20000;step++) {
      const data = await page.evaluate(()=>({snapshot:LudoGame.snapshot(),decision:LudoGame.diagnostics()}));
      const s=data.snapshot;
      if (s.error) throw new Error(s.error);
      const diag=data.decision?.diagnostics;
      if (diag?.fallback) throw new Error('Unexpected AI fallback: '+JSON.stringify(diag));
      if (diag?.execution==='worker'&&!seen.has(diag.requestId)) {
        seen.add(diag.requestId); decisions.push(diag);
      }
      if (s.state.phase==='finished'&&!s.busy) {finalState=s; break;}
      if (!s.busy&&s.state.activePlayer===0) {
        if (s.state.phase==='awaitingRoll') await page.locator('#roll-button').click();
        else await page.locator('.token.red.legal').first().click();
      } else await page.waitForTimeout(12);
    }
    if (!finalState||!await page.locator('#result-dialog').isVisible()) throw new Error('Game did not finish');
    if (!decisions.some(d=>d.difficulty===difficulty&&d.completedDepth>0)) throw new Error('No completed search layer');
    games.push({difficulty,rolls:finalState.rollCount,winner:finalState.state.winner,state:finalState.state});
    await page.locator('#play-again').click();
  }
  await page.locator('[data-difficulty="ultimate"]').click();
  await page.locator('#roll-button').click();
  let cancelled=false;
  for(let step=0;step<5000;step++) {
    const s=await page.evaluate(()=>LudoGame.snapshot());
    if(s.activity==='thinking') {
      // 与用户操作同一组按钮，记录同步处理耗时而非工具往返时间。
      const elapsed=await page.evaluate(()=>{
        const start=performance.now();
        document.querySelector('#restart-button').click();
        document.querySelector('#confirm-restart').click();
        return performance.now()-start;
      });
      if(elapsed>50)throw new Error('Restart handler blocked');
      await page.waitForTimeout(1600);
      const after=await page.evaluate(()=>({s:LudoGame.snapshot(),w:LudoGame.workerStatus()}));
      if(after.s.started||after.s.busy||after.s.rollCount||after.w.pending)throw new Error('Stale search polluted new game');
      cancelled={handlerMs:elapsed,workerStatus:after.w};break;
    }
    if(!s.busy&&s.state.activePlayer===0) {
      if(s.state.phase==='awaitingRoll')await page.locator('#roll-button').click();
      else await page.locator('.token.red.legal').first().click();
    } else await page.waitForTimeout(5);
  }
  if(!cancelled||errors.length||network.length)throw new Error(JSON.stringify({cancelled,errors,network}));
  const longTasks=await page.evaluate(()=>window.__aiLongTasks);
  await page.evaluate(report=>{window.__highAIReport=report;},{games,decisions,cancelled,longTasks,errors,network,
    userAgent:await page.evaluate(()=>navigator.userAgent),entry:page.url()});
  await page.context().setOffline(false);
}
