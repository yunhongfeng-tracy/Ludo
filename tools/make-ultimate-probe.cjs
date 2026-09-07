'use strict';

// 生成完全离线的浏览器验收页，只嵌入现有策略源码，不改动冻结的实验文件。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'ultimate-v2', 'budget-probe.html');
const files = ['src/engine.js', 'src/ai.js', 'src/ai-v2-eval.js', 'src/ai-v2-search.js', 'src/ai-v2-rollout.js', 'src/ai-v2-hybrid-eval.js', 'src/ai-v2-hybrid-search.js', 'src/ai-v2-endgame.js', 'src/ai-v2-combined.js'];
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const hash = source => crypto.createHash('sha256').update(source).digest('hex');
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function argumentsFor(argv) {
  const result = { only: null, matchedTime: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--matched-time') result.matchedTime = true;
    else if (argv[i] === '--only') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--only requires comma-separated variant names.');
      result.only = argv[++i].split(',').map(item => item.trim()).filter(Boolean);
      if (!result.only.length) throw new Error('--only must select at least one variant.');
    } else throw new Error('Unknown argument: ' + argv[i]);
  }
  return result;
}

function probeWorker() {
  'use strict';
  self.onmessage = function (event) {
    const request = event.data;
    if (!request || request.type !== 'choose') return;
    try {
      const before = JSON.stringify(request.state);
      LudoEngine.validateState(request.state);
      const random = LudoAI.createSeededRng(request.seed);
      let result;
      if (request.variant.kind === 'classic') result = LudoAI.chooseAction(request.state, 'ultimate', random, request.variant.config);
      else if (request.variant.kind === 'search') result = LudoV2Search.chooseAction(request.state, random, request.variant.config);
      else if (request.variant.kind === 'rollout') result = LudoV2Rollout.chooseAction(request.state, random, request.variant.config);
      else if (request.variant.kind === 'hybrid') result = LudoV2HybridSearch.chooseAction(request.state, random, request.variant.config);
      else if (request.variant.kind === 'combined') result = LudoV2Combined.chooseAction(request.state, random, request.variant.config);
      else throw new Error('Unknown probe variant.');
      const stateUnchanged = JSON.stringify(request.state) === before;
      const legal = LudoEngine.getLegalActions(request.state).includes(result.action);
      if (!stateUnchanged || !legal) throw new Error('Strategy violated input or legal-action contract.');
      self.postMessage({ type: 'result', id: request.id, result: result,
        legal: legal, stateUnchanged: stateUnchanged });
    } catch (error) {
      self.postMessage({ type: 'failure', id: request.id, error: String(error && error.stack || error) });
    }
  };
  self.postMessage({ type: 'ready', versions: {
    classic: LudoAI.STRATEGY_VERSION, evaluation: LudoV2Eval.EVALUATION_VERSION,
    search: LudoV2Search.STRATEGY_VERSION, rollout: LudoV2Rollout.STRATEGY_VERSION,
    combined: LudoV2Combined.STRATEGY_VERSION
  } });
}

function probePage(bootstrap) {
  'use strict';
  const button = document.getElementById('start');
  const download = document.getElementById('download');
  const status = document.getElementById('status');
  const detail = document.getElementById('detail');
  const activeSessions = new Set();
  let nextId = 0;
  let running = null;
  let aborted = false;

  function summary(samples) {
    const groups = [];
    for (const variant of bootstrap.variants) for (const mode of ['cold', 'warm']) {
      const all = samples.filter(sample => sample.variant === variant.name && sample.mode === mode);
      const good = all.filter(sample => !sample.error);
      const values = good.map(sample => sample.elapsedMs).sort((a, b) => a - b);
      const total = good.map(sample => sample.totalMs).sort((a, b) => a - b);
      const stops = {};
      for (const sample of good) {
        const reason = sample.diagnostics.stopReason || 'unreported';
        stops[reason] = (stops[reason] || 0) + 1;
      }
      groups.push({ variant: variant.name, mode: mode, requests: all.length, passed: good.length,
        errors: all.length - good.length,
        meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        p95Ms: values.length ? values[Math.ceil(values.length * .95) - 1] : null,
        maxMs: values.length ? values[values.length - 1] : null,
        totalP95Ms: total.length ? total[Math.ceil(total.length * .95) - 1] : null,
        stopReasons: stops });
    }
    return groups;
  }

  async function makeSession() {
    const started = performance.now();
    const url = URL.createObjectURL(new Blob([bootstrap.workerSource], { type: 'text/javascript' }));
    let worker;
    try { worker = new Worker(url); }
    catch (error) { URL.revokeObjectURL(url); throw error; }
    let startupTimer;
    let readyResolve, readyReject;
    const pending = new Map();
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const session = {
      startupMs: null, versions: null, disposed: false,
      dispose: function () {
        if (session.disposed) return;
        session.disposed = true;
        clearTimeout(startupTimer);
        worker.terminate();
        URL.revokeObjectURL(url);
        activeSessions.delete(session);
        readyReject(new Error('Worker disposed.'));
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Worker disposed.'));
        }
        pending.clear();
      },
      request: function (variant, fixture, seed) {
        if (session.disposed) return Promise.reject(new Error('Worker already disposed.'));
        const id = ++nextId;
        const began = performance.now();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            const error = new Error('Decision exceeded 1500 ms deadline.');
            error.elapsedMs = performance.now() - began;
            reject(error);
            session.dispose();
          }, bootstrap.deadlineMs);
          pending.set(id, { timer: timer, began: began, resolve: resolve, reject: reject });
          try { worker.postMessage({ type: 'choose', id: id, variant: variant, state: fixture.state, seed: seed }); }
          catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      }
    };
    activeSessions.add(session);
    startupTimer = setTimeout(() => {
      readyReject(new Error('Worker startup exceeded 1500 ms deadline.'));
      session.dispose();
    }, bootstrap.deadlineMs);
    worker.onmessage = function (event) {
      const data = event.data;
      if (data && data.type === 'ready') {
        clearTimeout(startupTimer);
        session.startupMs = performance.now() - started;
        if (session.startupMs > bootstrap.deadlineMs) {
          readyReject(new Error('Worker startup exceeded 1500 ms deadline.'));
          session.dispose();
          return;
        }
        session.versions = data.versions;
        URL.revokeObjectURL(url);
        readyResolve(session);
        return;
      }
      const request = data && pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      const elapsedMs = performance.now() - request.began;
      if (elapsedMs > bootstrap.deadlineMs) {
        const error = new Error('Decision exceeded 1500 ms deadline.');
        error.elapsedMs = elapsedMs;
        request.reject(error);
        session.dispose();
      } else if (data.type === 'failure') request.reject(new Error(data.error));
      else request.resolve({ ...data, elapsedMs: elapsedMs });
    };
    worker.onerror = function (event) {
      const error = new Error(event.message || 'Worker execution failed.');
      readyReject(error);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
      session.dispose();
    };
    worker.onmessageerror = function () {
      readyReject(new Error('Worker message could not be decoded.'));
      session.dispose();
    };
    try { return await ready; } catch (error) { session.dispose(); throw error; }
  }

  async function perform() {
    aborted = false;
    button.disabled = true;
    download.disabled = true;
    detail.textContent = '';
    const result = {
      status: 'running', startedAt: new Date().toISOString(), completedAt: null,
      mode: bootstrap.matchedTime ? 'matched-600ms' : 'product-budgets',
      methodology: bootstrap.methodology,
      generatedAt: bootstrap.generatedAt, generatorVersion: bootstrap.generatorVersion,
      sourceHashes: bootstrap.sourceHashes, configHashes: bootstrap.configHashes,
      workerSourceHash: bootstrap.workerSourceHash, generatorHash: bootstrap.generatorHash,
      generatedBy: bootstrap.generatedBy,
      device: { userAgent: navigator.userAgent, platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        deviceMemoryGiB: navigator.deviceMemory || null, language: navigator.language,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio },
        crossOriginIsolated: window.crossOriginIsolated, protocol: location.protocol },
      variants: bootstrap.variants, fixtures: bootstrap.fixtures, repetitions: bootstrap.repetitions,
      plannedRequests: bootstrap.variants.length * bootstrap.fixtures.length * bootstrap.repetitions * 2,
      samples: [], warmups: [], errors: [], summary: [], uiHeartbeat: { targetIntervalMs: 50, ticks: 0, maxGapMs: 0 },
      longTasks: [], longTaskObserverSupported: false
    };
    window.__ultimateProbe = result;
    let previousTick = performance.now();
    const heartbeat = setInterval(() => {
      const current = performance.now();
      result.uiHeartbeat.ticks++;
      result.uiHeartbeat.maxGapMs = Math.max(result.uiHeartbeat.maxGapMs, current - previousTick);
      previousTick = current;
      document.getElementById('heartbeat').textContent = '界面响应计数：' + result.uiHeartbeat.ticks;
    }, 50);
    let observer = null;
    try {
      if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) result.longTasks.push({ startTime: entry.startTime, durationMs: entry.duration });
        });
        observer.observe({ type: 'longtask', buffered: false });
        result.longTaskObserverSupported = true;
      }
    } catch (_) { observer = null; }

    async function sample(variant, fixture, repeat, mode, session, warmup) {
      const began = performance.now();
      const before = JSON.stringify(fixture.state);
      // 冷热与不同候选使用相同的策略种子，便于对照。
      const seed = 'ultimate-browser-probe-v1:' + fixture.id + ':' + repeat;
      const record = { variant: variant.name, kind: variant.kind, fixture: fixture.id, repeat: repeat,
        mode: mode, seed: seed, config: variant.config, baseConfig: variant.baseConfig,
        startupMs: null, elapsedMs: null, totalMs: null, diagnostics: null,
        legal: false, mainStateUnchanged: false, workerStateUnchanged: false };
      let owned = null;
      try {
        if (!session) {
          if (mode === 'warm' || mode === 'warmup') throw new Error('Warm Worker unavailable; request was not relabeled as cold.');
          owned = await makeSession();
          session = owned;
        }
        record.startupMs = owned ? session.startupMs : 0;
        record.workerStartupMs = session.startupMs;
        record.versions = session.versions;
        const reply = await session.request(variant, fixture, seed);
        record.elapsedMs = reply.elapsedMs;
        record.action = reply.result.action;
        record.score = reply.result.score;
        record.diagnostics = reply.result.diagnostics;
        record.legal = reply.legal && LudoEngine.getLegalActions(fixture.state).includes(reply.result.action);
        record.workerStateUnchanged = reply.stateUnchanged === true;
        record.mainStateUnchanged = JSON.stringify(fixture.state) === before;
        if (!record.legal || !record.workerStateUnchanged || !record.mainStateUnchanged) {
          throw new Error('Legal-action or state-preservation verification failed.');
        }
      } catch (error) {
        if (Number.isFinite(error && error.elapsedMs)) record.elapsedMs = error.elapsedMs;
        record.error = String(error && error.stack || error);
        result.errors.push({ variant: variant.name, fixture: fixture.id, repeat: repeat, mode: mode,
          warmup: !!warmup, error: record.error });
        if (session) session.dispose();
      } finally {
        record.totalMs = performance.now() - began;
        if (owned) owned.dispose();
      }
      (warmup ? result.warmups : result.samples).push(record);
      status.textContent = '已完成 ' + result.samples.length + ' / ' + result.plannedRequests +
        ' 个请求，当前 ' + variant.name + '，' + fixture.id + '，' + mode + '。';
      return record;
    }

    try {
      for (const variant of bootstrap.variants) {
        if (aborted) break;
        // 冷请求每次新建 Worker；warm 共用一个 Worker，先做一次有记录的预热。
        for (const fixture of bootstrap.fixtures) for (let repeat = 0; repeat < bootstrap.repetitions; repeat++) {
          if (aborted) break;
          await sample(variant, fixture, repeat, 'cold', null, false);
        }
        let warmSession = null;
        try {
          for (const fixture of bootstrap.fixtures) for (let repeat = 0; repeat < bootstrap.repetitions; repeat++) {
            if (aborted) break;
            if (!warmSession || warmSession.disposed) {
              try {
                warmSession = await makeSession();
                await sample(variant, bootstrap.fixtures[0], -1, 'warmup', warmSession, true);
              } catch (error) {
                result.errors.push({ variant: variant.name, mode: 'warm-startup', error: String(error) });
                warmSession = null;
              }
            }
            await sample(variant, fixture, repeat, 'warm', warmSession, false);
          }
        } finally { if (warmSession) warmSession.dispose(); }
      }
    } catch (error) {
      result.errors.push({ mode: 'probe', error: String(error && error.stack || error) });
    } finally {
      clearInterval(heartbeat);
      if (observer) {
        for (const entry of observer.takeRecords()) result.longTasks.push({ startTime: entry.startTime, durationMs: entry.duration });
        observer.disconnect();
      }
      for (const session of Array.from(activeSessions)) session.dispose();
      result.summary = summary(result.samples);
      result.completedAt = new Date().toISOString();
      result.status = aborted ? 'aborted' : result.errors.length ? 'completed-with-errors' : 'completed';
      result.passed = !aborted && result.errors.length === 0 && result.samples.length === result.plannedRequests;
      result.performancePassed = result.passed && result.summary.filter(group => group.mode === 'warm').every(group => group.p95Ms <= 850) && result.samples.every(sample => sample.totalMs <= bootstrap.deadlineMs);
      result.performanceCriteria = { warmP95Ms: 850, wholeSampleDeadlineMs: bootstrap.deadlineMs, note: 'Whole sample includes Worker startup when cold. passed checks correctness; performancePassed additionally checks these timing limits.' };
      detail.textContent = JSON.stringify({ status: result.status, passed: result.passed,
        summary: result.summary, uiHeartbeat: result.uiHeartbeat, longTasks: result.longTasks,
        errors: result.errors }, null, 2);
      status.textContent = result.status + '，已记录 ' + result.samples.length + ' 个请求，' + result.errors.length + ' 个错误。';
      button.disabled = false;
      download.disabled = false;
    }
    return result;
  }

  window.runProbe = function () {
    if (running) return running;
    running = perform().finally(() => { running = null; });
    return running;
  };
  button.addEventListener('click', () => { window.runProbe().catch(error => { status.textContent = String(error); }); });
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(window.__ultimateProbe, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = bootstrap.matchedTime ? 'ultimate-budget-probe-matched.json' : 'ultimate-budget-probe.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener('pagehide', () => {
    aborted = true;
    for (const session of Array.from(activeSessions)) session.dispose();
  });
  document.getElementById('config').textContent = bootstrap.variants.map(variant => variant.name).join('、') +
    '；' + (bootstrap.matchedTime ? '统一 600 毫秒，放宽操作额度' : '产品候选原始预算') +
    '；' + bootstrap.fixtures.length + ' 个局面，冷请求与暖请求各重复 3 次。';
}

function main() {
  const args = argumentsFor(process.argv.slice(2));
  const sources = Object.fromEntries(files.map(file => [file, read(file)]));
  for (const [file, source] of Object.entries(sources)) {
    if (source.includes('\uFFFD')) throw new Error(file + ' contains an encoding replacement character.');
  }
  const E = require('../src/engine.js');
  const A = require('../src/ai.js');
  const configHashes = {};
  const config = name => {
    const file = 'doc/ultimate-v2-configs/' + name;
    const source = read(file);
    configHashes[file] = hash(source);
    return JSON.parse(source.replace(/^\uFEFF/, ''));
  };
  let variants = [
    { name: 'classic60', kind: 'classic', config: { ...A.LEVEL_CONFIGS.ultimate } },
    { name: 'classic180', kind: 'classic', config: config('budget-180k.json') },
    { name: 'search60', kind: 'search', config: config('search-60k.json') },
    { name: 'search120', kind: 'search', config: config('search-120k.json') },
    { name: 'rollout64', kind: 'rollout', config: config('rollout-64.json') },
    { name: 'rollout256', kind: 'rollout', config: config('rollout-256.json') },
    { name: 'hybrid60', kind: 'hybrid', config: config('hybrid-60k.json') },
    { name: 'combined', kind: 'combined', config: { ...require('../src/ai-v2-combined.js').DEFAULT_CONFIG } }
  ];
  if (args.only) {
    const known = new Set(variants.map(variant => variant.name));
    for (const name of args.only) if (!known.has(name)) throw new Error('Unknown variant: ' + name);
    variants = variants.filter(variant => args.only.includes(variant.name));
  }
  variants = variants.map(variant => ({ ...variant, baseConfig: { ...variant.config },
    config: args.matchedTime ? { ...variant.config, budgetMs: 600, maxNodes: 1000000000,
      ...(variant.kind === 'rollout' ? { maxRounds: 1000000 } : { maxDepth: 256 }) } : variant.config }));
  const layouts = [
    { stage: 'opening', own: [0, 6, 12, -1], enemy: [3, 10, 24, -1], die: 6 },
    { stage: 'middle', own: [0, 12, 27, -1], enemy: [4, 18, 45, -1], die: 3 },
    { stage: 'ending', own: [48, 51, 54, 56], enemy: [44, 52, 55, 56], die: 3 },
    { stage: 'home', own: [51, 53, 55, 56], enemy: [51, 52, 54, 56], die: 1 }
  ];
  const fixtures = layouts.flatMap(layout => [0, 1].map(player => {
    const state = { ...E.createGame(player),
      tokenProgress: player === 0 ? [layout.own.slice(), layout.enemy.slice()] : [layout.enemy.slice(), layout.own.slice()],
      phase: 'awaitingMove', pendingDie: layout.die, consecutiveSixes: layout.die === 6 ? 1 : 0 };
    E.validateState(state);
    const legal = E.getLegalActions(state);
    const successors = legal.map(action => E.applyAction(state, action));
    if (new Set(successors.map(next => E.stateKey(next, { canonicalTokens: true }))).size < 2 ||
        successors.some(next => next.winner !== null)) throw new Error('Fixture must require a nontrivial choice.');
    return { id: layout.stage + '-player-' + player, stage: layout.stage, activePlayer: player,
      legalActions: legal, state: state };
  }));
  const workerSource = files.map(file => sources[file]).join('\n') + '\n(' + probeWorker.toString() + ')();\n';
  const bootstrap = {
    generatorVersion: 'ultimate-browser-budget-probe@2', generatedAt: new Date().toISOString(),
    sourceHashes: Object.fromEntries(files.map(file => [file, hash(sources[file])])), configHashes: configHashes,
    workerSourceHash: hash(workerSource), generatorHash: hash(fs.readFileSync(__filename, 'utf8')),
    generatedBy: { nodeVersion: process.version, platform: process.platform, arch: process.arch,
      cpuModel: os.cpus()[0] && os.cpus()[0].model, logicalProcessors: os.cpus().length },
    methodology: { requests: 'Eight fixed legal positions, both colors, three repetitions per cold and warm mode.',
      cold: 'A new Blob Worker for every request; startup and decision latency are recorded separately.',
      warm: 'One reused Worker per variant, with one separately recorded warmup before measured requests.',
      elapsedMs: 'Main-thread postMessage to result delivery; excludes cold Worker startup.',
      totalMs: 'Whole sample including startup when cold, validation and message handling.',
      fairness: 'Same fixtures and policy seeds across variants and cold/warm modes; all requests run sequentially.',
      matchedTime: '600 ms soft budget; node cap 1e9, search depth cap 256 or rollout round cap 1e6. Remaining caps and rollout horizons retained and reported.',
      limitation: 'A device-specific fixed-position timing probe, not a strength or all-position performance proof.' },
    repetitions: 3, deadlineMs: 1500, matchedTime: args.matchedTime, variants: variants, fixtures: fixtures,
    workerSource: workerSource
  };
  const pageSource = '(' + probePage.toString() + ')(' + scriptJson(bootstrap) + ');';
  for (const source of [sources['src/engine.js'], pageSource]) {
    if (/<\/script/i.test(source)) throw new Error('Unsafe inline script terminator.');
    new vm.Script(source);
  }
  new vm.Script(workerSource);
  const html = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>终极 AI 浏览器预算验收</title>' +
    '<style>body{margin:0;background:#f7f4ef;color:#25312c;font:16px/1.6 system-ui,sans-serif}main{max-width:1050px;margin:40px auto;padding:0 28px}h1{font-size:28px}button{font:inherit;padding:10px 20px;margin:8px 12px 8px 0;border:1px solid #536f61;border-radius:8px;background:#fff;color:#254c39}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid #ddd;padding:20px;font-size:13px}#status{font-weight:600}small{color:#56655c}</style></head>' +
    '<body><main><h1>终极 AI 浏览器预算验收</h1><p id="config"></p>' +
    '<p>离线运行，所有策略在独立 Worker 中计算。每个请求校验合法走法和状态不变。请关闭其他计算任务后开始。</p>' +
    '<button id="start">开始验收</button><button id="download" disabled>下载完整 JSON</button>' +
    '<p id="status">尚未开始。</p><p id="heartbeat">界面响应计数：0</p>' +
    '<small>也可调用 window.runProbe()，完整结果位于 window.__ultimateProbe。耗时结果仅代表当前设备与这些局面。</small>' +
    '<pre id="detail"></pre></main><script>' + sources['src/engine.js'] + '</script><script>' + pageSource + '</script></body></html>\n';
  if (html.includes('\uFFFD')) throw new Error('Generated HTML contains an encoding replacement character.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html, 'utf8');
  console.log(JSON.stringify({ output: output, bytes: Buffer.byteLength(html), sha256: hash(html),
    variants: variants.map(variant => variant.name), matchedTime: args.matchedTime,
    plannedRequests: variants.length * fixtures.length * 3 * 2, sourceHashes: bootstrap.sourceHashes }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error && error.stack || error); process.exitCode = 1; }
}
