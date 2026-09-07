/* 单文件 Blob Worker 的请求、取消和期限管理；不接触真实骰子源。 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LudoAIClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  function create(source, options = {}) {
    const WorkerClass = options.WorkerClass || root.Worker;
    const deadlineMs = options.deadlineMs === undefined ? 1500 : options.deadlineMs;
    const now = () => root.performance ? root.performance.now() : Date.now();
    let worker = null, url = null, pending = null, serial = 0, ready = false;
    let workerStarted = 0, startupMs = null;
    const counters = { requests: 0, completed: 0, cancelled: 0, failures: 0, staleMessages: 0 };
    function shutdown() {
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
      worker = null; ready = false;
      if (url) root.URL.revokeObjectURL(url);
      url = null;
    }
    function takePending() {
      const request = pending;
      pending = null;
      if (request) clearTimeout(request.timer);
      return request;
    }
    function fail(code) {
      const request = takePending();
      shutdown();
      if (request) { counters.failures++; request.reject(Object.assign(new Error(code), { code })); }
    }
    function cancel() {
      const request = takePending();
      shutdown();
      if (request) { counters.cancelled++; request.resolve({ cancelled: true }); }
    }
    function ensureWorker() {
      if (worker) return;
      if (typeof WorkerClass !== 'function') throw new Error('worker-unavailable');
      workerStarted = now(); startupMs = null;
      url = root.URL.createObjectURL(new root.Blob([source], { type: 'text/javascript' }));
      worker = new WorkerClass(url);
      const instance = worker;
      const currentWorker = () => {
        if (worker === instance) return true;
        counters.staleMessages++;
        return false;
      };
      worker.onerror = event => { if (event.preventDefault) event.preventDefault(); if (currentWorker()) fail('worker-error'); };
      worker.onmessageerror = () => { if (currentWorker()) fail('worker-message-error'); };
      worker.onmessage = event => {
        if (!currentWorker()) return;
        const message = event.data;
        if (!message || typeof message !== 'object') { fail('invalid-worker-message'); return; }
        if (message.type === 'ready') {
          ready = true; startupMs = now() - workerStarted;
          return;
        }
        if (!pending) { counters.staleMessages++; return; }
        const identity = pending.identity;
        if (!Object.keys(identity).every(key => message[key] === identity[key])) {
          counters.staleMessages++;
          return;
        }
        if (message.type === 'failure') { fail('worker-search-error'); return; }
        if (message.type !== 'result' || !message.result ||
            !pending.legalActions.includes(message.result.action) || !message.result.diagnostics) {
          fail('invalid-worker-result'); return;
        }
        const request = takePending(); counters.completed++;
        request.resolve({ ...message.result, diagnostics: { ...message.result.diagnostics,
          execution: 'worker', requestId: identity.requestId, endToEndMs: now() - request.started,
          coldStart: request.coldStart, workerStartupMs: startupMs } });
      };
    }
    function choose(state, difficulty, context) {
      if (pending) cancel();
      const identity = { requestId: ++serial, gameId: context.gameId, stateRevision: context.stateRevision,
        rulesetId: state.rulesetId, boardVersion: state.boardVersion, difficulty,
        strategyVersion: context.strategyVersion, evaluationVersion: context.evaluationVersion };
      const coldStart = !worker;
      const started = now();
      counters.requests++;
      return new Promise((resolve, reject) => {
        pending = { identity, legalActions: context.legalActions.slice(), resolve, reject, started, coldStart,
          timer: setTimeout(() => fail('worker-timeout'), deadlineMs) };
        try {
          ensureWorker();
          worker.postMessage({ type: 'choose', ...identity, state });
        } catch { fail('worker-unavailable'); }
      });
    }
    return Object.freeze({ choose, cancel,
      status: () => ({ ...counters, ready, pending: Boolean(pending), startupMs, deadlineMs }) });
  }
  return Object.freeze({ create });
});
