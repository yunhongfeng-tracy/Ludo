'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../src/engine.js');
const B = require('../tools/ultimate-lab.cjs');
const baseline = path.join(__dirname, 'fixtures/ai-v1/ai.js');

function spec(overrides = {}) {
  return { mode: 'development', execution: 'nodes', seed: 'v2-lab-unit-only', blocks: 1, maxRolls: 10000, candidate: { path: baseline, level: 'beginner', api: 'classic' }, opponent: { path: baseline, level: 'beginner', api: 'classic' }, ...overrides };
}
function manifest(overrides = {}) { return B.buildManifest(spec(overrides)); }
const firstLegal = { chooseAction(state) { return { action: E.getLegalActions(state)[0], diagnostics: { stopReason: 'unit-policy' } }; } };
function runtime(candidate = firstLegal, opponent = firstLegal) { return { engine: E, modules: { candidate, opponent } }; }
async function withDirectory(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ludo-v2-lab-test-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('旧 AI 与引擎快照匹配冻结的原始 SHA256', () => {
  const dir = path.dirname(baseline), frozen = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(frozen.files['ai.js'].sha256, 'fcea334ab40ddc1138124fc3b49692fdd1fd6e097e35af8008ac9f9839b3b2b9');
  assert.equal(frozen.files['engine.js'].sha256, 'd651b61942b3cc762c4cebbd2b0b273a86dce6b764010cdd55e8105e53b00591');
  for (const [file, entry] of Object.entries(frozen.files)) assert.equal(B.sha256(fs.readFileSync(path.join(dir, file))), entry.sha256);
});

test('每块四局覆盖候选双方阵营与先后手，复用裁判骰流但隔离策略种子', () => {
  const games = B.makeSchedule(spec({ blocks: 3 }));
  assert.equal(games.length, 12);
  for (let block = 0; block < 3; block += 1) {
    const group = games.filter(game => game.block === block);
    assert.equal(new Set(group.map(game => game.candidatePlayer + ':' + (game.firstPlayer === game.candidatePlayer))).size, 4);
    assert.equal(new Set(group.map(game => game.judgeSeed)).size, 1);
    assert.equal(new Set(group.flatMap(game => game.policySeeds)).size, 8);
    assert.ok(group.every(game => game.policySeeds.every(seed => seed !== game.judgeSeed)));
  }
  assert.equal(new Set(games.map(game => game.judgeSeed)).size, 3);
});

test('策略多消费随机数不改变裁判骰点，拒绝采样排除 uint32 多余尾数', () => {
  const game = B.makeSchedule(spec())[0];
  function sample(extra) {
    const dice = B.diceRng(game.judgeSeed), policy = B.policyRng(game.policySeeds[0]);
    return Array.from({ length: 100 }, () => { for (let i = 0; i < extra; i += 1) policy(); return dice(); });
  }
  assert.deepEqual(sample(0), sample(40));
  assert.notEqual(B.makeSchedule(spec({ mode: 'holdout' }))[0].judgeSeed, game.judgeSeed);
  const input = [4294967295, 4294967292, 0, 5];
  const die = B.diceRng(() => input.shift());
  assert.equal(die(), 1); assert.equal(die(), 6); assert.equal(input.length, 0);
});

test('manifest 冻结配置、传递模块与种子，篡改或源码变化会拒绝恢复', async () => withDirectory(dir => {
  const moduleFile = path.join(dir, 'policy.cjs');
  fs.writeFileSync(moduleFile, "module.exports={chooseAction:function(){return {action:0}}};\n", 'utf8');
  const m = manifest({ candidate: { path: moduleFile, api: 'direct', options: { maxRounds: 12, budgetMs: 600 } } });
  assert.equal(B.verifyManifest(m), true);
  assert.ok(m.sources[path.join(__dirname, 'fixtures/ai-v1/engine.js')]);
  assert.equal(m.agents.candidate.options.maxRounds, 12);
  assert.throws(() => B.verifyManifest({ ...m, maxRolls: 20 }), /hash mismatch/);
  fs.appendFileSync(moduleFile, '// changed\n', 'utf8');
  assert.throws(() => B.verifyManifest(m), /Source changed/);
}));

test('direct 和 classic 参数顺序正确，节点模式只移除时间保护', () => {
  const m = manifest({ candidate: { path: baseline, api: 'direct', options: { budgetMs: 600, maxRounds: 8 } } });
  let directCalls = 0, classicCalls = 0;
  const direct = { chooseAction(state, rng, options) { assert.equal(arguments.length, 3); assert.equal(typeof rng, 'function'); assert.equal(options.budgetMs, Infinity); assert.equal(options.maxRounds, 8); directCalls += 1; return firstLegal.chooseAction(state); } };
  const classic = { chooseAction(state, level, rng, options) { assert.equal(arguments.length, 4); assert.equal(level, 'beginner'); assert.equal(typeof rng, 'function'); assert.equal(options.budgetMs, Infinity); classicCalls += 1; return firstLegal.chooseAction(state); } };
  const row = B.runGame(m, m.games[0], runtime(direct, classic));
  assert.equal(row.status, 'finished'); assert.ok(directCalls > 0 && classicCalls > 0);
  const time = manifest({ execution: 'time', candidate: { path: baseline, api: 'direct', options: { budgetMs: 600 } } });
  const check = { chooseAction(state, rng, options) { assert.equal(options.budgetMs, 600); return firstLegal.chooseAction(state); } };
  assert.equal(B.runGame(time, time.games[0], runtime(check)).status, 'finished');
});

test('固定节点配置重放真实终局与动作轨迹一致', () => {
  const m = manifest();
  const a = B.runBlock(m, 0, runtime()), b = B.runBlock(m, 0, runtime());
  for (let i = 0; i < 4; i += 1) {
    assert.equal(a.games[i].status, 'finished');
    assert.equal(a.games[i].traceSha256, b.games[i].traceSha256);
    assert.equal(a.games[i].winner, b.games[i].winner);
    assert.equal(a.games[i].rolls, b.games[i].rolls);
  }
});

test('非法动作、修改输入、截断分别保留，不能作为正常失败局', () => {
  const m = manifest();
  const illegal = B.runGame(m, m.games[0], runtime({ chooseAction() { return { action: 9 }; } }));
  assert.equal(illegal.status, 'error'); assert.equal(illegal.candidateScore, null); assert.match(illegal.failure.message, /illegal/);
  const mutated = B.runGame(m, m.games[0], runtime({ chooseAction(state) { state.turnNumber += 1; return firstLegal.chooseAction(state); } }));
  assert.equal(mutated.status, 'error'); assert.match(mutated.failure.message, /mutated/);
  const short = manifest({ maxRolls: 1 }), block = B.runBlock(short, 0, runtime()), report = B.summarize(short, [block]);
  assert.equal(report.truncated, 4); assert.equal(report.candidateLosses, 0); assert.equal(report.thresholdsMet, false);
  assert.deepEqual(report.sensitivityAcrossAllPlannedGames, { allUnfinishedLose: 0, allUnfinishedWin: 1 });
});

test('完整块检查点恢复，半行另存后整块重跑，不丢弃已保存块', async () => withDirectory(dir => {
  const m = manifest({ blocks: 2 }), row = B.runBlock(m, 0, runtime()), file = path.join(dir, 'blocks.jsonl');
  B.appendDurably(file, row); fs.appendFileSync(file, '{"partial', 'utf8');
  assert.throws(() => B.loadCheckpoint(dir, m), /Incomplete checkpoint tail/);
  assert.deepEqual(B.loadCheckpoint(dir, m, true), [row]);
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('checkpoint-tail.')));
  assert.deepEqual(B.loadCheckpoint(dir, m), [row]);
}));

test('检查点不允许重复块、伪造分数或仅三局的块', async () => withDirectory(dir => {
  const m = manifest(), row = B.runBlock(m, 0, runtime()), file = path.join(dir, 'blocks.jsonl');
  B.appendDurably(file, row); B.appendDurably(file, row);
  assert.throws(() => B.loadCheckpoint(dir, m), /Duplicate/);
  row.games[0].candidateScore = 1 - row.games[0].candidateScore;
  fs.writeFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  assert.throws(() => B.loadCheckpoint(dir, m), /record hash/);
  const body = { manifestId: m.id, block: 0, games: row.games.slice(0, 3) };
  fs.writeFileSync(file, JSON.stringify({ ...body, recordHash: B.sha256(B.canonical(body)) }) + '\n', 'utf8');
  assert.throws(() => B.loadCheckpoint(dir, m), /complete four-game/);
}));

test('两比较 alpha=.025 的块级 Hoeffding 下界，不把块内四局视作独立样本', () => {
  assert.equal(B.blockInterval([1]).lowerBound, 0);
  const interval = B.blockInterval(Array(400).fill(0.75));
  assert.ok(Math.abs(interval.radius - Math.sqrt(Math.log(40) / 800)) < 1e-12);
  assert.equal(interval.blocks, 400); assert.ok(interval.lowerBound > 0.5);
  assert.throws(() => B.blockInterval([1.01]), /\[0, 1\]/);
});

test('留出未跑满隐藏胜负，开发集满足门槛也不声称正式或四档通过', () => {
  const held = manifest({ mode: 'holdout', blocks: 2 }), partial = B.summarize(held, [B.runBlock(held, 0, runtime())]);
  assert.equal(partial.scoresHiddenUntilPlannedEnd, true); assert.equal(Object.hasOwn(partial, 'candidateWins'), false);
  const m = manifest({ blocks: 40 });
  const base = B.runBlock(m, 0, runtime());
  const blocks = Array.from({ length: 40 }, (_, block) => ({ block, games: base.games.map(game => ({ ...game, candidateScore: 1 })) }));
  const report = B.summarize(m, blocks);
  assert.equal(report.thresholdsMet, true); assert.equal(report.statisticalAcceptance, false); assert.equal(report.fourLevelReleaseAcceptance, false);
});

test('同一目录独占锁，持锁进程仍在时不删除锁', async () => withDirectory(dir => {
  const release = B.lockDirectory(dir);
  assert.throws(() => B.lockDirectory(dir), /in use/);
  release(); assert.equal(fs.existsSync(path.join(dir, 'run.lock')), false);
}));

test('真实 Worker 并行完整块并恢复，已完成块不重复运行', async () => withDirectory(async dir => {
  const m = manifest({ blocks: 3 });
  const first = await B.execute(dir, m, 2, 2);
  assert.equal(first.completedBlocks, 2); assert.equal(first.recordedGames, 8); assert.equal(first.errors, 0);
  const saved = B.loadCheckpoint(dir, m).map(block => block.recordHash).sort();
  const final = await B.execute(dir, m, 2);
  assert.equal(final.completedBlocks, 3); assert.equal(final.recordedGames, 12); assert.equal(final.errors, 0);
  assert.ok(saved.every(hash => B.loadCheckpoint(dir, m).some(block => block.recordHash === hash)));
  assert.equal(fs.readFileSync(path.join(dir, 'games.jsonl'), 'utf8').trim().split('\n').length, 12);
}));
