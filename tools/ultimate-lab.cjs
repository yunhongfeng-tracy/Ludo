'use strict';

// 终极候选实验：按独立四局块分配 Worker，只有完整块进入恢复检查点。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const E = require('../src/engine.js');
const VERSION = 'ultimate-paired-block-lab@1';
const STATISTICS = Object.freeze({ method: 'block-hoeffding-one-sided@1', familyAlpha: 0.05, comparisons: 2, alpha: 0.025, observedRateMinimum: 0.55, lowerBoundExclusiveMinimum: 0.5, plannedLooks: 1, gamesPerBlock: 4 });

function invariant(ok, message) { if (!ok) throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function positive(value, name) { invariant(Number.isSafeInteger(value) && value > 0, name + ' must be a positive integer.'); return value; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function deriveSeed(...parts) { return sha256(canonical(parts)); }
function uint32Rng(seed) {
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}
function policyRng(seed) { const next = uint32Rng(seed); return () => next() / 4294967296; }
function diceRng(seed) {
  const next = typeof seed === 'function' ? seed : uint32Rng(seed);
  return () => { let value; do { value = next(); } while (value >= 4294967292); return value % 6 + 1; };
}
function moduleDependencies(file, found = new Set()) {
  const resolved = require.resolve(file);
  if (found.has(resolved)) return found;
  found.add(resolved);
  require(resolved);
  for (const child of require.cache[resolved].children) moduleDependencies(child.filename, found);
  return found;
}
function resolveAgent(spec) {
  const file = path.resolve(spec.path);
  const api = spec.api || 'classic';
  invariant(['classic', 'direct'].includes(api), 'Agent api must be classic or direct.');
  const ai = require(file);
  invariant(typeof ai.chooseAction === 'function', file + ' must export chooseAction.');
  const supplied = spec.options || {};
  invariant(supplied && typeof supplied === 'object' && !Array.isArray(supplied), 'Agent options must be a JSON object.');
  const defaults = api === 'classic' ? ai.LEVEL_CONFIGS?.[spec.level] : ai.DEFAULT_OPTIONS || ai.DEFAULT_CONFIG;
  const options = { ...(defaults || {}), ...supplied };
  for (const [key, value] of Object.entries(options)) if (typeof value === 'number') invariant(Number.isFinite(value) && value >= 0, 'Manifest numeric options must be finite and nonnegative: ' + key);
  return { path: file, api, level: spec.level || 'ultimate', options, strategyVersion: ai.STRATEGY_VERSION || ai.VERSION || 'unreported', evaluationVersion: ai.EVALUATION_VERSION || 'unreported' };
}
function makeSchedule(spec) {
  const games = [];
  for (let block = 0; block < spec.blocks; block += 1) {
    const blockSeed = deriveSeed(VERSION, spec.mode, spec.seed, block);
    const judgeSeed = deriveSeed(blockSeed, 'judge-dice');
    for (let candidatePlayer = 0; candidatePlayer < 2; candidatePlayer += 1) for (let starts = 0; starts < 2; starts += 1) {
      const slot = candidatePlayer * 2 + starts;
      games.push({ id: block + ':' + slot, block, slot, candidatePlayer, firstPlayer: starts ? candidatePlayer : 1 - candidatePlayer, judgeSeed, policySeeds: [0, 1].map(player => deriveSeed(blockSeed, 'policy', slot, player)) });
    }
  }
  return games;
}
function buildManifest(spec) {
  invariant(['development', 'validation', 'holdout'].includes(spec.mode), 'Invalid mode.');
  invariant(['nodes', 'time'].includes(spec.execution), 'Invalid execution mode.');
  invariant(typeof spec.seed === 'string' && spec.seed.length > 0, 'Explicit nonempty --seed is required.');
  positive(spec.blocks, 'blocks'); positive(spec.maxRolls, 'max-rolls');
  const agents = { candidate: resolveAgent(spec.candidate), opponent: resolveAgent(spec.opponent) };
  // 冻结同步 require 的传递依赖，任何变动都禁止混入同一批次。
  const files = new Set([__filename, require.resolve('../src/engine.js')]);
  for (const agent of Object.values(agents)) moduleDependencies(agent.path, files);
  const sources = Object.fromEntries([...files].sort().map(file => [file, sha256(fs.readFileSync(file))]));
  const manifest = { schema: VERSION, createdAt: new Date().toISOString(), mode: spec.mode, execution: spec.execution, seed: spec.seed, blocks: spec.blocks, maxRolls: spec.maxRolls, agents, sources, statistics: STATISTICS, rng: 'sha256-domain-mulberry32-rejection@1', games: makeSchedule(spec), machine: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length }, checkpoint: 'one-complete-four-game-block-per-line', pairing: 'same-chronological-dice-stream-in-all-four-games', limitation: 'Only two ultimate-candidate comparisons are covered by this alpha allocation. This is not acceptance of all four difficulty levels.' };
  return { ...manifest, id: sha256(canonical(manifest)) };
}
function verifyManifest(manifest, checkSources = true) {
  const { id, ...body } = manifest;
  invariant(manifest.schema === VERSION && id === sha256(canonical(body)), 'Manifest content/hash mismatch.');
  invariant(canonical(manifest.statistics) === canonical(STATISTICS), 'Statistical method mismatch.');
  invariant(canonical(manifest.games) === canonical(makeSchedule(manifest)), 'Frozen schedule mismatch.');
  if (checkSources) for (const [file, hash] of Object.entries(manifest.sources)) invariant(fs.existsSync(file) && sha256(fs.readFileSync(file)) === hash, 'Source changed: ' + file + '. Use a new output directory.');
  return true;
}
function diagnostics() { return { timesMs: [], decisions: 0, nodes: 0, completedRounds: 0, completedRollouts: 0, terminalRollouts: 0, truncatedRollouts: 0, simulatedSteps: 0, depths: {}, stopReasons: {} }; }
function addDiagnostic(total, result, elapsed) {
  const d = result.diagnostics || {};
  total.timesMs.push(elapsed); total.decisions += 1;
  total.nodes += d.visitedNodes || 0;
  for (const key of ['completedRounds', 'completedRollouts', 'terminalRollouts', 'truncatedRollouts', 'simulatedSteps']) total[key] += d[key] || 0;
  total.depths[d.completedDepth || 0] = (total.depths[d.completedDepth || 0] || 0) + 1;
  const reason = d.stopReason || 'unreported'; total.stopReasons[reason] = (total.stopReasons[reason] || 0) + 1;
}
function runGame(manifest, game, runtime) {
  const engine = runtime?.engine || E;
  const modules = runtime?.modules || Object.fromEntries(Object.entries(manifest.agents).map(([role, agent]) => [role, require(agent.path)]));
  const dice = diceRng(game.judgeSeed), policies = game.policySeeds.map(policyRng);
  const decisions = { candidate: diagnostics(), opponent: diagnostics() };
  const trace = crypto.createHash('sha256');
  const started = performance.now();
  let state = engine.createGame(game.firstPlayer), rolls = 0, status = 'truncated', failure = null;
  try {
    while (state.phase !== 'finished' && rolls < manifest.maxRolls) {
      const die = dice(); trace.update('d' + die + ';');
      state = engine.applyRoll(state, die); rolls += 1; engine.validateState(state);
      if (state.phase === 'awaitingMove') {
        const player = state.activePlayer;
        const role = player === game.candidatePlayer ? 'candidate' : 'opponent';
        const agent = manifest.agents[role], options = { ...agent.options };
        if (manifest.execution === 'nodes') options.budgetMs = Infinity;
        const snapshot = JSON.stringify(state), decisionStart = performance.now();
        // 仅传入公开局面与独立策略 RNG，不传裁判种子或未来点数。
        const result = agent.api === 'direct' ? modules[role].chooseAction(state, policies[player], options) : modules[role].chooseAction(state, agent.level, policies[player], options);
        addDiagnostic(decisions[role], result || {}, performance.now() - decisionStart);
        invariant(snapshot === JSON.stringify(state), 'AI mutated its input.');
        invariant(result && engine.getLegalActions(state).includes(result.action), 'AI returned illegal action.');
        trace.update('a' + player + ':' + result.action + ';');
        state = engine.applyAction(state, result.action); engine.validateState(state);
      }
    }
    if (state.phase === 'finished') { invariant(state.winner === 0 || state.winner === 1, 'Terminal state has no winner.'); status = 'finished'; }
    else failure = { reason: 'max-rolls', message: 'No real terminal result within frozen roll limit.' };
  } catch (error) { status = 'error'; failure = { reason: 'correctness-error', message: String(error.message), stack: String(error.stack) }; }
  return { manifestId: manifest.id, id: game.id, assignment: game, status, rolls, winner: status === 'finished' ? state.winner : null, candidateScore: status === 'finished' ? Number(state.winner === game.candidatePlayer) : null, decisions, elapsedMs: performance.now() - started, traceSha256: trace.digest('hex'), finalState: state, failure, completedAt: new Date().toISOString() };
}
function runBlock(manifest, block, runtime) {
  const games = manifest.games.filter(game => game.block === block);
  invariant(games.length === 4, 'A block must contain four games.');
  const row = { manifestId: manifest.id, block, games: games.map(game => runGame(manifest, game, runtime)) };
  return { ...row, recordHash: sha256(canonical(row)) };
}
function appendDurably(file, row) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeFileSync(fd, JSON.stringify(row) + '\n', 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function loadCheckpoint(out, manifest, repairTail = false) {
  const file = path.join(out, 'blocks.jsonl');
  if (!fs.existsSync(file)) return [];
  const bytes = fs.readFileSync(file), newline = bytes.lastIndexOf(10);
  if (newline !== bytes.length - 1) {
    invariant(repairTail, 'Incomplete checkpoint tail; use run to recover.');
    const tail = bytes.subarray(newline + 1), archive = 'checkpoint-tail.' + sha256(tail) + '.txt';
    fs.writeFileSync(path.join(out, archive), tail);
    appendDurably(path.join(out, 'recovery.jsonl'), { at: new Date().toISOString(), archive, bytes: tail.length });
    fs.truncateSync(file, newline + 1);
  }
  const seen = new Set();
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    let row; try { row = JSON.parse(line); } catch { throw new Error('Corrupt checkpoint line ' + (index + 1) + '. Nothing discarded.'); }
    const { recordHash, ...body } = row;
    invariant(row.manifestId === manifest.id, 'Checkpoint belongs to another manifest.');
    invariant(recordHash === sha256(canonical(body)), 'Checkpoint record hash mismatch.');
    invariant(Number.isInteger(row.block) && row.block >= 0 && row.block < manifest.blocks && !seen.has(row.block), 'Duplicate or unscheduled checkpoint block.');
    seen.add(row.block);
    const schedule = manifest.games.filter(game => game.block === row.block);
    invariant(row.games?.length === 4, 'Checkpoint must contain a complete four-game block.');
    for (let i = 0; i < 4; i += 1) {
      const game = row.games[i];
      invariant(game.manifestId === manifest.id && game.id === schedule[i].id && canonical(game.assignment) === canonical(schedule[i]), 'Checkpoint assignment mismatch.');
      invariant(['finished', 'truncated', 'error'].includes(game.status), 'Invalid game status.');
      invariant(game.status === 'finished' ? (game.winner === 0 || game.winner === 1) && game.candidateScore === Number(game.winner === game.assignment.candidatePlayer) : game.winner === null && game.candidateScore === null, 'Game result/status mismatch.');
    }
    return row;
  });
}
function percentile(values, fraction) { if (!values.length) return null; const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]; }
function timing(values) { return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.length ? values.reduce((a, b) => Math.max(a, b), 0) : null }; }
function blockInterval(scores) {
  if (!scores.length) return { blocks: 0, mean: null, radius: null, lowerBound: null };
  invariant(scores.every(score => Number.isFinite(score) && score >= 0 && score <= 1), 'Block scores must lie in [0, 1].');
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const radius = Math.sqrt(Math.log(1 / STATISTICS.alpha) / (2 * scores.length));
  return { blocks: scores.length, mean, radius, lowerBound: Math.max(0, mean - radius) };
}
function summarize(manifest, blocks) {
  const rows = blocks.flatMap(block => block.games), finished = rows.filter(row => row.status === 'finished');
  const allRecorded = blocks.length === manifest.blocks, hidden = manifest.mode === 'holdout' && !allRecorded;
  const wins = finished.reduce((sum, row) => sum + row.candidateScore, 0);
  const scores = blocks.filter(block => block.games.every(game => game.status === 'finished')).map(block => block.games.reduce((sum, game) => sum + game.candidateScore, 0) / 4);
  const interval = blockInterval(scores);
  const thresholdsMet = finished.length === manifest.blocks * 4 && interval.mean >= STATISTICS.observedRateMinimum && interval.lowerBound > STATISTICS.lowerBoundExclusiveMinimum;
  const metrics = {};
  for (const role of ['candidate', 'opponent']) {
    const total = diagnostics();
    for (const row of rows) {
      const source = row.decisions[role];
      total.timesMs.push(...source.timesMs);
      for (const key of ['decisions', 'nodes', 'completedRounds', 'completedRollouts', 'terminalRollouts', 'truncatedRollouts', 'simulatedSteps']) total[key] += source[key];
      for (const key of ['depths', 'stopReasons']) for (const [value, count] of Object.entries(source[key])) total[key][value] = (total[key][value] || 0) + count;
    }
    metrics[role] = { ...total, timesMs: undefined, timingMs: timing(total.timesMs) };
  }
  return { manifestId: manifest.id, purpose: manifest.mode, execution: manifest.execution, plannedBlocks: manifest.blocks, completedBlocks: blocks.length, plannedGames: manifest.blocks * 4, recordedGames: rows.length, finishedGames: finished.length, errors: rows.filter(row => row.status === 'error').length, truncated: rows.filter(row => row.status === 'truncated').length, allRecorded, statistics: STATISTICS,
    ...(hidden ? { scoresHiddenUntilPlannedEnd: true, statisticalAcceptance: false } : { candidateWins: wins, candidateLosses: finished.length - wins, observedRateFinishedGames: finished.length ? wins / finished.length : null, blockStatistics: interval, thresholdsMet, statisticalAcceptance: manifest.mode === 'holdout' && thresholdsMet, sensitivityAcrossAllPlannedGames: { allUnfinishedLose: wins / (manifest.blocks * 4), allUnfinishedWin: (wins + manifest.blocks * 4 - finished.length) / (manifest.blocks * 4) } }),
    fourLevelReleaseAcceptance: false, decisionMetrics: metrics, gameTimingMs: timing(rows.map(row => row.elapsedMs)), totalRecordedComputeMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0), limitation: 'This one comparison does not establish four-level strength. Development/validation are not held-out evidence. Parallel wall-clock timings depend on contention; browser and same-device isolated timing are separate checks.' };
}
function lockDirectory(out) {
  const file = path.join(out, 'run.lock');
  if (fs.existsSync(file)) {
    const old = readJson(file); invariant(old.hostname === os.hostname(), 'Run is locked by another host.');
    let alive = true; try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    invariant(!alive, 'Run directory is in use by process ' + old.pid + '.'); fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx'), token = crypto.randomUUID();
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), token, at: new Date().toISOString() }), 'utf8'); fs.closeSync(fd);
  return () => { if (fs.existsSync(file) && readJson(file).token === token) fs.unlinkSync(file); };
}
function exportGames(out, blocks) {
  const temporary = path.join(out, 'games.jsonl.tmp');
  fs.writeFileSync(temporary, blocks.slice().sort((a, b) => a.block - b.block).flatMap(block => block.games).map(row => JSON.stringify(row) + '\n').join(''), 'utf8');
  fs.renameSync(temporary, path.join(out, 'games.jsonl'));
}
async function execute(out, manifest, workerCount, maxBlocks = Infinity, onProgress = () => {}, shouldStop = () => false) {
  positive(workerCount, 'workers'); verifyManifest(manifest);
  const release = lockDirectory(out), workers = new Set();
  try {
    const blocks = loadCheckpoint(out, manifest, true), done = new Set(blocks.map(row => row.block));
    const pending = Array.from({ length: manifest.blocks }, (_, index) => index).filter(block => !done.has(block)).slice(0, maxBlocks);
    let cursor = 0;
    async function consume() {
      while (cursor < pending.length && !shouldStop()) {
        const block = pending[cursor++];
        const row = await new Promise((resolve, reject) => {
          const worker = new Worker(__filename, { workerData: { manifest, block } }); workers.add(worker);
          let received = false;
          worker.once('message', message => { received = true; resolve(message); });
          worker.once('error', reject);
          worker.once('exit', code => { workers.delete(worker); if (!received) reject(new Error('Worker exited before completing block ' + block + ', code ' + code)); });
        });
        verifyManifest(manifest);
        appendDurably(path.join(out, 'blocks.jsonl'), row); blocks.push(row);
        onProgress({ completedBlocks: blocks.length, plannedBlocks: manifest.blocks, block: row.block, statuses: row.games.map(game => game.status), seconds: Number((row.games.reduce((sum, game) => sum + game.elapsedMs, 0) / 1000).toFixed(2)) });
      }
    }
    await Promise.all(Array.from({ length: Math.min(workerCount, pending.length) }, consume));
    exportGames(out, blocks);
    const report = summarize(manifest, blocks); writeJson(path.join(out, 'report.json'), report);
    return report;
  } finally { await Promise.all([...workers].map(worker => worker.terminate())); release(); }
}
function parseArgs(argv) {
  const args = argv.slice(), command = args.shift() || 'help', options = {};
  if (command === '--help' || command === '-h') return { command: 'help', options };
  while (args.length) { const key = args.shift(); invariant(key.startsWith('--') && args.length && !args[0].startsWith('--'), 'Expected --name value.'); invariant(!Object.hasOwn(options, key.slice(2)), 'Duplicate option ' + key); options[key.slice(2)] = args.shift(); }
  return { command, options };
}
const HELP = `Ultimate AI paired-block lab
  run --out DIR --candidate MODULE --candidate-api direct|classic
      --candidate-level ultimate [--candidate-options FILE.json]
      --opponent MODULE [--opponent-api classic|direct]
      --opponent-level advanced|ultimate [--opponent-options FILE.json]
      --seed TEXT [--blocks 8] [--workers 2] [--mode development|validation|holdout]
      [--execution nodes|time] [--max-rolls 10000] [--max-blocks N]
  init (same experiment options, freezes manifest without running)
  run --out DIR [--workers 2] [--max-blocks N] (resume frozen run)
  report --out DIR

blocks.jsonl is the authoritative checkpoint; each line holds all four games.
games.jsonl is a derived export. Interrupted blocks are rerun in full.
nodes disables only budgetMs, retaining all operation limits; time retains it.
Use workers=1 for isolated time comparison. Parallel time runs include contention.
Holdout incomplete reports/progress hide scores, raw checkpoint is audit evidence.
`;
async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'help') { process.stdout.write(HELP); return; }
  invariant(['init', 'run', 'report'].includes(command), 'Unknown command ' + command);
  const experimentKeys = ['candidate', 'candidate-api', 'candidate-level', 'candidate-options', 'opponent', 'opponent-api', 'opponent-level', 'opponent-options', 'seed', 'blocks', 'mode', 'execution', 'max-rolls'];
  const allowed = command === 'report' ? ['out'] : ['out', 'workers', 'max-blocks', ...experimentKeys];
  for (const key of Object.keys(options)) invariant(allowed.includes(key), 'Unknown option --' + key);
  invariant(options.out, '--out is required.');
  const out = path.resolve(options.out), file = path.join(out, 'manifest.json');
  if (!fs.existsSync(file)) {
    invariant(command !== 'report', 'No manifest found.');
    invariant(options.candidate && options.opponent, '--candidate and --opponent are required to initialize.');
    invariant(!fs.existsSync(out) || fs.readdirSync(out).length === 0, 'Output directory must be new or empty.');
    const spec = { mode: options.mode || 'development', execution: options.execution || 'nodes', seed: options.seed, blocks: Number(options.blocks || 8), maxRolls: Number(options['max-rolls'] || 10000) };
    for (const role of ['candidate', 'opponent']) spec[role] = { path: options[role], api: options[role + '-api'] || 'classic', level: options[role + '-level'] || 'ultimate', options: options[role + '-options'] ? readJson(path.resolve(options[role + '-options'])) : {} };
    const manifest = buildManifest(spec); fs.mkdirSync(out, { recursive: true });
    const fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, JSON.stringify(manifest, null, 2) + '\n', 'utf8'); fs.closeSync(fd);
    process.stdout.write(JSON.stringify({ initialized: out, manifestId: manifest.id, plannedGames: manifest.games.length }) + '\n');
  } else {
    invariant(command !== 'init', 'Manifest already exists; frozen runs are not overwritten.');
    invariant(!experimentKeys.some(key => Object.hasOwn(options, key)), 'Resume accepts only --out, --workers and --max-blocks; frozen experiment options cannot be changed.');
  }
  const manifest = readJson(file); verifyManifest(manifest);
  if (command === 'init') return;
  if (command === 'report') {
    const release = lockDirectory(out);
    try { const blocks = loadCheckpoint(out, manifest); const report = summarize(manifest, blocks); exportGames(out, blocks); writeJson(path.join(out, 'report.json'), report); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); } finally { release(); }
    return;
  }
  let stop = false; const signal = () => { stop = true; }; process.on('SIGINT', signal); process.on('SIGTERM', signal);
  try {
    const workers = Number(options.workers || 2), maxBlocks = options['max-blocks'] ? positive(Number(options['max-blocks']), 'max-blocks') : Infinity;
    const report = await execute(out, manifest, workers, maxBlocks, progress => process.stdout.write(JSON.stringify(progress) + '\n'), () => stop);
    process.stdout.write(JSON.stringify({ recordedGames: report.recordedGames, errors: report.errors, truncated: report.truncated, report: path.join(out, 'report.json') }) + '\n');
    if (report.errors || report.truncated) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal); }
}

module.exports = { VERSION, STATISTICS, canonical, sha256, deriveSeed, diceRng, policyRng, resolveAgent, makeSchedule, buildManifest, verifyManifest, runGame, runBlock, appendDurably, loadCheckpoint, blockInterval, summarize, lockDirectory, execute, main };
if (!isMainThread && workerData?.manifest) { verifyManifest(workerData.manifest); parentPort.postMessage(runBlock(workerData.manifest, workerData.block)); }
else if (require.main === module) main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
