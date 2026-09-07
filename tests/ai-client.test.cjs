'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Client = require('../src/ai-client.js');
const E = require('../src/engine.js');
const AI = require('../src/ai.js');

function setup(deadlineMs = 1000) {
  const workers = [];
  class FakeWorker {
    constructor() { workers.push(this); this.terminated = false; }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated = true; }
    send(overrides = {}) {
      const { type, state, ...identity } = this.request;
      this.onmessage({ data: { type: 'result', ...identity,
        result: { action: 0, diagnostics: { completedDepth: 2, difficulty: identity.difficulty } }, ...overrides } });
    }
  }
  const client = Client.create('/* test worker */', { WorkerClass: FakeWorker, deadlineMs });
  const state = E.applyRoll(E.createGame(1), 6);
  const context = { gameId: 1, stateRevision: 2, strategyVersion: AI.STRATEGY_VERSION,
    evaluationVersion: AI.EVALUATION_VERSION, legalActions: E.getLegalActions(state) };
  return { client, workers, state, context };
}

test('Worker 返回只提取合法建议，不能覆盖主线程状态，暖启动复用线程', async () => {
  const {client,workers,state,context} = setup();
  const before = JSON.stringify(state);
  try {
    const first = client.choose(state,'advanced',context);
    workers[0].onmessage({data:{type:'ready'}});
    workers[0].send();
    assert.equal((await first).diagnostics.execution,'worker');
    const second = client.choose(state,'ultimate',{...context,stateRevision:3});
    workers[0].send();
    assert.equal((await second).diagnostics.coldStart,false);
    assert.equal(workers.length,1);
    assert.equal(JSON.stringify(state),before);
    assert.equal(client.status().completed,2);
  } finally {client.cancel();}
});

test('请求和棋局版本不匹配的返回会丢弃，当前合法返回才执行', async () => {
  const {client,workers,state,context} = setup();
  try {
    const promise = client.choose(state,'advanced',context);
    for (const override of [{gameId:99},{requestId:999},{stateRevision:1},{strategyVersion:'old'},
      {evaluationVersion:'old'},{boardVersion:99},{rulesetId:'other'},{difficulty:'ultimate'}]) workers[0].send(override);
    assert.equal(client.status().pending,true);
    assert.equal(client.status().staleMessages,8);
    workers[0].send();
    assert.equal((await promise).action,0);
  } finally {client.cancel();}
});

test('重开取消立即结束待处理请求并终止旧线程，旧消息不能完成新请求', async () => {
  const {client,workers,state,context} = setup();
  const first = client.choose(state,'ultimate',context);
  const oldHandler = workers[0].onmessage;
  const oldRequest = workers[0].request;
  client.cancel();
  assert.deepEqual(await first,{cancelled:true});
  assert.ok(workers[0].terminated);
  const second = client.choose(state,'advanced',{...context,gameId:2});
  oldHandler({data:{...oldRequest,type:'result',result:{action:0,diagnostics:{}}}});
  assert.ok(client.status().pending);
  workers[1].send();
  assert.equal((await second).action,0);
  client.cancel();
});

for (const kind of ['illegal','failure','error','messageerror','timeout']) {
  test(`Worker ${kind} 明确失败，释放请求供控制器使用预备动作`, async () => {
    const {client,workers,state,context} = setup(kind==='timeout'?15:1000);
    const promise = client.choose(state,'ultimate',context);
    const rejected = assert.rejects(promise,/worker/);
    if (kind==='illegal') workers[0].send({result:{action:99,diagnostics:{}}});
    if (kind==='failure') workers[0].send({type:'failure'});
    if (kind==='error') workers[0].onerror({preventDefault(){}});
    if (kind==='messageerror') workers[0].onmessageerror();
    await rejected;
    assert.equal(client.status().pending,false);
    assert.equal(client.status().failures,1);
    assert.ok(workers[0].terminated);
    client.cancel();
  });
}

test('旧线程迟到的错误或格式错误消息不能终止新的搜索', async () => {
  const {client,workers,state,context} = setup();
  const first=client.choose(state,'ultimate',context);
  const oldError=workers[0].onerror, oldMessageError=workers[0].onmessageerror, oldMessage=workers[0].onmessage;
  client.cancel(); await first;
  const second=client.choose(state,'advanced',{...context,gameId:2});
  oldError({preventDefault(){}}); oldMessageError(); oldMessage({data:null}); oldMessage({data:{type:'ready'}});
  assert.ok(client.status().pending);
  assert.equal(client.status().failures,0);
  assert.equal(workers[1].terminated,false);
  workers[1].send();
  assert.equal((await second).action,0);
  client.cancel();
});
