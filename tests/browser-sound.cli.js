// 通过 playwright-cli run-code --filename 执行。使用真实 Web Audio 图和真实随机棋局。
// 数值音频验收只证明输出非零、同步和停止，不替代人耳对音色的试听。
async page => {
  const report = { kind: 'game-sound', url: page.url(), errors: [], cases: {}, limits: ['音色未以人耳试听', '隐藏及页面恢复使用合成生命周期事件'] };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const artifact = () => page.evaluate(async () => {
    const bytes = await (await fetch(location.href, { cache: 'no-store' })).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return { sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''), bytes: bytes.byteLength };
  });
  report.artifact = await artifact();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setViewportSize({ width: 1536, height: 1024 });
  const originalPreference = await page.evaluate(() => localStorage.getItem('ludo.sound.enabled'));

  await page.addInitScript(() => {
    const mode = sessionStorage.getItem('ludo.sound.test-mode') || 'normal';
    const audit = window.__soundAudit = { mode, contexts: [], devices: [], resumes: [], resumeDelay: 0,
      calls: [], stops: [], enables: [], samples: [], instances: [] };
    const time = () => performance.now();
    const snapshot = () => window.LudoGame?.snapshot();
    const priorStates = new Map();
    let soundApi;
    Object.defineProperty(window, 'LudoSound', {
      configurable: true,
      get: () => soundApi,
      set(api) {
        soundApi = { ...api, create(...args) {
          const instance = api.create(...args);
          audit.instances.push(instance);
          return { ...instance,
            unlock(...values) { return instance.unlock(...values); },
            play(kind, options) {
              const game = snapshot();
              const moving = document.querySelector('.token.moving');
              const owner = document.querySelector('#turn-owner')?.textContent || '';
              const actor = owner.includes('电脑') ? 1 : owner.includes('你') ? 0 : null;
              const key = game && `${game.generation}:${game.revision}`;
              const previous = game && priorStates.get(game.generation);
              let expectedSteps;
              if (kind === 'step' && game && moving && previous) {
                const player = Number(moving.dataset.player), token = Number(moving.dataset.token);
                const from = previous.tokenProgress[player][token];
                const to = game.state.tokenProgress[player][token];
                if (from !== to) expectedSteps = from === -1 ? 1 : to - from;
              }
              const call = { kind, options, at: time(), actor, key, expectedSteps,
                activity: game?.activity, rollCount: game?.rollCount,
                reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
                position: moving ? [moving.style.left, moving.style.top] : null };
              audit.calls.push(call);
              if (game) priorStates.set(game.generation, game.state);
              call.result = instance.play(kind, options);
              return call.result;
            },
            stop(...values) {
              const before = instance.info?.();
              const result = instance.stop(...values);
              audit.stops.push({ at: time(), before, after: instance.info?.() });
              return result;
            },
            setEnabled(value) {
              const result = instance.setEnabled(value);
              audit.enables.push({ value, at: time(), info: instance.info?.() });
              return result;
            }
          };
        } };
      }
    });

    const NativeAudio = window.AudioContext || window.webkitAudioContext;
    if (mode === 'unsupported') {
      window.AudioContext = undefined;
      window.webkitAudioContext = undefined;
    } else if (NativeAudio) {
      const originalConnect = AudioNode.prototype.connect;
      const analysers = new WeakMap();
      AudioNode.prototype.connect = function (destination, ...args) {
        const analyser = analysers.get(this.context);
        if (analyser && destination === this.context.destination && this !== analyser) {
          originalConnect.call(this, analyser, ...args);
          return destination;
        }
        return originalConnect.call(this, destination, ...args);
      };
      const WrappedAudio = new Proxy(NativeAudio, {
        construct(Target, args) {
          if (mode === 'constructor-failure') throw new Error('验收注入：音频设备不可用');
          const context = Reflect.construct(Target, args);
          const info = { at: time(), activeGesture: navigator.userActivation.isActive,
            initialState: context.state, states: [context.state], nodes: [], peak: 0 };
          audit.contexts.push(info);
          audit.devices.push(context);
          const nativeResume = context.resume.bind(context);
          context.resume = () => {
            const record = { at: time(), delay: audit.resumeDelay, before: context.state };
            audit.resumes.push(record);
            const resume = () => nativeResume().then(() => {
              record.completedAt = time();
              record.after = context.state;
            });
            return audit.resumeDelay > 0
              ? new Promise(resolve => setTimeout(resolve, audit.resumeDelay)).then(resume)
              : resume();
          };
          context.addEventListener('statechange', () => info.states.push(context.state));
          const analyser = context.createAnalyser();
          analyser.fftSize = 512;
          originalConnect.call(analyser, context.destination);
          analysers.set(context, analyser);
          const data = new Float32Array(analyser.fftSize);
          setInterval(() => {
            analyser.getFloatTimeDomainData(data);
            let peak = 0;
            for (const value of data) peak = Math.max(peak, Math.abs(value));
            info.peak = Math.max(info.peak, peak);
            audit.samples.push({ at: time(), peak });
          }, 8);
          for (const factory of ['createBufferSource', 'createOscillator']) {
            const nativeFactory = context[factory].bind(context);
            context[factory] = (...values) => {
              if (mode === 'node-failure') throw new Error('验收注入：音频节点创建失败');
              const node = nativeFactory(...values);
              const record = { type: factory, created: time(), starts: [], stops: [] };
              info.nodes.push(record);
              for (const operation of ['start', 'stop']) {
                const original = node[operation].bind(node);
                node[operation] = (...schedule) => {
                  record[`${operation}s`].push({ at: time(), audioTime: context.currentTime, schedule });
                  return original(...schedule);
                };
              }
              return node;
            };
          }
          return context;
        }
      });
      window.AudioContext = WrappedAudio;
      if (window.webkitAudioContext) window.webkitAudioContext = WrappedAudio;
    }
  });

  const read = () => page.evaluate(() => {
    const a = window.__soundAudit;
    const calls = a.calls.map((call, index) => {
      const end = Math.min(call.at + (call.kind === 'roll' ? 1500 : 240), a.calls[index + 1]?.at ?? Infinity);
      const samples = a.samples.filter(sample => sample.at >= call.at && sample.at < end);
      return { ...call, peak: Math.max(0, ...samples.map(sample => sample.peak)) };
    });
    return { calls, stops: a.stops, enables: a.enables, contexts: a.contexts, resumes: a.resumes,
      info: a.instances.map(instance => instance.info?.()),
      recentPeak: Math.max(0, ...a.samples.filter(sample => sample.at > performance.now() - 70).map(sample => sample.peak)),
      game: LudoGame.snapshot(), preference: localStorage.getItem('ludo.sound.enabled') };
  });
  const drive = async (target, timeout = 60000) => page.evaluate(async ({ target, timeout }) => {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const state = LudoGame.snapshot();
      if (state.error) throw new Error(state.error);
      const calls = __soundAudit.calls;
      const steps = calls.filter(call => call.kind === 'step');
      if (target === 'coverage' && [0, 1].every(actor => calls.some(call => call.kind === 'roll' && call.actor === actor)) &&
          [0, 1].every(actor => steps.some(call => call.actor === actor)) && steps.some(call => call.expectedSteps > 1) && !state.busy) return;
      if (target === 'human-roll' && !state.busy && state.state.activePlayer === 0 && state.state.phase === 'awaitingRoll') return;
      if (target === 'move' && state.started && state.revision > 3 && state.state.tokenProgress.flat().some(value => value >= 0) && !state.busy) return;
      if (!state.busy && state.state.activePlayer === 0) {
        if (state.state.phase === 'awaitingRoll') document.querySelector('#roll-button').click();
        else if (state.state.phase === 'awaitingMove') document.querySelector('.token.red.legal')?.click();
      }
      await new Promise(resolve => setTimeout(resolve, 12));
    }
    throw new Error(`未收集到实际棋局样本 ${target}：${JSON.stringify(__soundAudit.calls.map(call => ({ kind: call.kind, actor: call.actor, expectedSteps: call.expectedSteps })))}`);
  }, { target, timeout });
  const reload = async (mode = 'normal', preference = null) => {
    await page.evaluate(({ mode, preference }) => {
      sessionStorage.setItem('ludo.sound.test-mode', mode);
      if (preference === null) localStorage.removeItem('ludo.sound.enabled');
      else localStorage.setItem('ludo.sound.enabled', preference);
      location.hash = '';
    }, { mode, preference });
    await page.reload();
  };

  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await reload();
    check(await page.locator('#sound-button').getAttribute('aria-pressed') === 'true', '首次默认音效未开启');
    check((await read()).contexts.length === 0, '点击之前就创建了 AudioContext');
    await page.locator('#roll-button').click();
    await page.waitForFunction(() => __soundAudit.contexts.some(context => context.states.includes('running')));
    const unlock = await read();
    check(unlock.contexts.length === 1 && unlock.contexts[0].activeGesture, '开局手势没有解锁真实音频上下文');
    await drive('coverage', 90000);
    await page.waitForTimeout(180);
    const coverage = await read();
    const groups = new Map();
    for (const call of coverage.calls.filter(call => call.kind === 'step')) {
      if (!groups.has(call.key)) groups.set(call.key, []);
      groups.get(call.key).push(call);
    }
    for (const calls of groups.values()) {
      const expected = calls.find(call => call.expectedSteps)?.expectedSteps;
      check(expected > 0 && calls.length === expected, `逐格声音次数错误：${JSON.stringify(calls)}`);
      check(calls.every((call, index) => !index || call.at - calls[index - 1].at >= 80), '逐格声音没有跟随移动节拍');
      check(new Set(calls.map(call => JSON.stringify(call.position))).size === calls.length, '相同棋子落点重复触发声音');
    }
    for (const kind of ['roll', 'step']) for (const actor of [0, 1]) {
      check(coverage.calls.some(call => call.kind === kind && call.actor === actor && call.peak > 0.00001), `${kind}/${actor} 没有检测到非零音频输出`);
    }
    report.cases.realGame = { contexts: coverage.contexts.map(({ nodes, ...context }) => ({ ...context, sourceNodes: nodes.length })),
      calls: coverage.calls, moveGroups: groups.size, diceAndStepsHaveSignal: true };
    await page.screenshot({ path: 'output/playwright/sound-playing.png' });

    // 真实滚动期间静音，检查立即释放声音和后续静默。
    await drive('human-roll');
    await page.locator('#roll-button').click();
    await page.waitForFunction(() => LudoGame.snapshot().activity === 'rolling');
    await page.locator('#sound-button').click();
    await page.waitForTimeout(40); // 允许模块的 12ms 防爆音退音，并等待原生 onended。
    const muted = await read();
    check(muted.info[0].activeVoices === 0, '静音后仍保留活动声音');
    check(muted.preference === 'false', '未记住静音偏好');
    await page.waitForTimeout(220);
    const silent = await read();
    check(silent.recentPeak < 0.00001, '静音后仍检测到音频信号');
    const mutedSources = silent.contexts[0].nodes.length;
    await drive('human-roll');
    await page.locator('#roll-button').click();
    await page.waitForTimeout(850);
    const laterMuted = await read();
    check(laterMuted.contexts[0].nodes.length === mutedSources && laterMuted.recentPeak < 0.00001, '静音后掷骰仍创建发声节点');
    report.cases.mute = { activeVoices: muted.info[0].activeVoices, peakAfter220ms: silent.recentPeak, laterSilent: true };
    await page.reload();
    check(await page.locator('#sound-button').getAttribute('aria-pressed') === 'false', '刷新未恢复静音偏好');
    await page.locator('#roll-button').click();
    await page.waitForTimeout(100);
    check((await read()).contexts.length === 0, '记住静音后开局仍创建音频上下文');
    report.cases.persistedMute = true;
    await page.locator('#sound-button').click();
    await page.waitForTimeout(140);
    const enabledAgain = await read();
    check(enabledAgain.preference === 'true' && enabledAgain.calls.some(call => call.kind === 'step' && call.peak > 0.00001),
      '重新打开音效后没有以真实手势解锁并播放预览声');
    report.cases.reenabled = { preference: enabledAgain.preference, gestureUnlocked: enabledAgain.contexts[0].activeGesture,
      previewPeak: Math.max(0, ...enabledAgain.calls.filter(call => call.kind === 'step').map(call => call.peak)) };

    // 生命周期场景都从实际掷骰开始；合成事件不冒充真实后台标签页覆盖。
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const action of ['restart', 'hidden', 'updates']) {
      await reload();
      await page.locator('#roll-button').click();
      await drive('human-roll');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.locator('#roll-button').click();
      await page.waitForFunction(() => LudoGame.snapshot().activity === 'rolling' && __soundAudit.instances[0].info().activeVoices > 0);
      const before = await read();
      if (action === 'restart') {
        await page.locator('#restart-button').click();
        await page.locator('#confirm-restart').click();
      } else if (action === 'hidden') {
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
      } else await page.locator('.updates-link').click();
      await page.waitForTimeout(40);
      const after = await read();
      check(after.stops.length > before.stops.length && after.info[0].activeVoices === 0, `${action} 没有停止正在播放的声音`);
      await page.waitForTimeout(750);
      const settled = await read();
      check(settled.recentPeak < 0.00001, `${action} 停止后再次发声`);
      report.cases[action] = { stopped: true, activeVoices: after.info[0].activeVoices, peakAfter750ms: settled.recentPeak };
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }

    // 使用原生 suspend/resume，只延迟恢复设备的调用，验证异步解锁与当前骰子动画的边界。
    report.cases.suspendedResume = {};
    for (const action of ['resume', 'expired', 'restart', 'mute']) {
      await reload();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // 初级电脑在掷骰结束后至少等待 600ms，给过期检查留下独立于下一掷的观察窗口。
      await page.locator('[data-difficulty="beginner"]').click();
      await page.locator('#roll-button').click();
      await drive('human-roll');
      await page.waitForTimeout(180);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const suspended = await page.evaluate(async action => {
        __soundAudit.resumeDelay = action === 'expired' ? 800 : action === 'resume' ? 300 : 600;
        await __soundAudit.devices[0].suspend();
        return { state: __soundAudit.devices[0].state, calls: __soundAudit.calls.length,
          sources: __soundAudit.contexts[0].nodes.length, resumeCount: __soundAudit.resumes.length, game: LudoGame.snapshot() };
      }, action);
      check(suspended.state === 'suspended', '原生 AudioContext 没有进入 suspended');
      await page.locator('#roll-button').click();
      const during = await read();
      check(during.game.activity === 'rolling' && during.game.rollCount === suspended.game.rollCount + 1,
        '音频恢复等待阻塞了实际掷骰');
      check(during.calls.length === suspended.calls && during.contexts[0].nodes.length === suspended.sources,
        '设备尚未恢复就尝试播放声音');
      check(during.resumes.length === suspended.resumeCount + 1 && !during.resumes.at(-1).completedAt, '未覆盖异步 resume 等待窗口');
      const rollKey = `${during.game.generation}:${during.game.revision}`;
      if (action === 'restart') {
        await page.locator('#restart-button').click();
        await page.locator('#confirm-restart').click();
      } else if (action === 'mute') await page.locator('#sound-button').click();
      if (action === 'restart' || action === 'mute') {
        const cancelled = await read();
        check(!cancelled.resumes.at(-1).completedAt, `${action} 未发生在设备恢复完成之前`);
      }
      await page.waitForTimeout(action === 'expired' ? 920 : 720);
      const settled = await read();
      check(settled.resumes.at(-1).after === 'running', '原生 resume 没有实际恢复设备');
      const currentRoll = settled.calls.filter(call => call.kind === 'roll' && call.key === rollKey);
      if (action === 'resume') {
        check(currentRoll.length === 1 && currentRoll[0].peak > 0.00001,
          '原生 suspended 恢复后的第一掷没有且仅有一次实际音频输出');
        check(currentRoll[0].options.duration > 0 && currentRoll[0].options.duration < 0.35,
          '恢复后没有按当前动画的剩余时长播放');
        report.cases.suspendedResume.resume = { suspended: true, rollContinuedImmediately: true,
          resumeDelay: settled.resumes.at(-1).delay, deferredRoll: currentRoll[0], onlyCurrentRollPlayed: true };
      } else if (action === 'expired') {
        check(currentRoll.length === 0, '骰子动画已结束，迟到的 resume 仍补播旧掷骰声');
        check(settled.calls.length === suspended.calls && settled.contexts[0].nodes.length === suspended.sources,
          '过期恢复意外创建了发声节点');
        check(settled.game.rollCount === during.game.rollCount && settled.game.activity !== 'rolling',
          '过期检查窗口被后续掷骰污染');
        report.cases.suspendedResume.expired = { suspended: true, resumeDelay: settled.resumes.at(-1).delay,
          animationCompleted: true, noDeferredPlayback: true, sourceNodesAdded: 0 };
      } else {
        check(settled.calls.length === suspended.calls && settled.contexts[0].nodes.length === suspended.sources,
          `${action} 取消后，旧 resume Promise 又补播了声音`);
        check(settled.info[0].activeVoices === 0 && settled.recentPeak < 0.00001,
          `${action} 取消旧恢复后仍检测到音频输出`);
        report.cases.suspendedResume[action] = { cancelledBeforeResume: true, noDeferredPlayback: true,
          activeVoices: settled.info[0].activeVoices, recentPeak: settled.recentPeak };
      }
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await reload();
    await page.locator('#roll-button').click();
    await drive('coverage', 30000);
    const reduced = await read();
    const reducedMoves = new Map();
    for (const call of reduced.calls.filter(call => call.kind === 'step')) reducedMoves.set(call.key, (reducedMoves.get(call.key) || 0) + 1);
    check([...reducedMoves.values()].every(count => count === 1), '减少动画模式为同一步播放多次声音');
    report.cases.reducedMotion = { moveGroups: reducedMoves.size, oneSoundPerMove: true };

    for (const mode of ['unsupported', 'constructor-failure', 'node-failure']) {
      await reload(mode);
      await page.locator('#roll-button').click();
      await drive('move', 30000);
      const failedAudio = await read();
      check(failedAudio.game.started && !failedAudio.game.error && failedAudio.game.state.tokenProgress.flat().some(progress => progress >= 0), `${mode} 阻断游戏`);
      report.cases[mode] = { gameStarted: true, rollCount: failedAudio.game.rollCount, pieceMoved: true, gameError: failedAudio.game.error };
    }
    check(report.errors.length === 0, `页面脚本异常：${JSON.stringify(report.errors)}`);
    report.finalArtifact = await artifact();
    report.artifactUnchanged = report.artifact.sha256 === report.finalArtifact.sha256;
    report.passed = true;
    await page.evaluate(value => { window.__ludoSoundReport = value; }, report);
    console.log(JSON.stringify(report));
  } finally {
    await page.evaluate(preference => {
      sessionStorage.removeItem('ludo.sound.test-mode');
      if (preference === null) localStorage.removeItem('ludo.sound.enabled');
      else localStorage.setItem('ludo.sound.enabled', preference);
    }, originalPreference);
  }
}
