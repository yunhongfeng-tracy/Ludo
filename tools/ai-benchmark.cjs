'use strict';

// 无界面相邻档位评测。裁判骰源、策略随机流、动画互相隔离。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const E = require('../src/engine.js');
const AI = require('../src/ai-policy.js');
const { strategySources } = require('./ai-product-sources.cjs');

const ROOT = path.resolve(__dirname, '..');
const VERSION = 'adjacent-block-benchmark@2';
const RNG_VERSION = 'sha256-domain-mulberry32-rejection@1';
const PAIRS = Object.freeze(['beginner-medium', 'medium-advanced', 'advanced-ultimate']);
const LEVELS = Object.freeze(['beginner', 'medium', 'advanced', 'ultimate']);
const STATISTICS = Object.freeze({
  method: 'block-hoeffding-one-sided@1', familyAlpha: 0.05, comparisons: 3,
  alphaPerPair: 0.05 / 3, observedRateMinimum: 0.55, lowerBoundExclusiveMinimum: 0.5,
  plannedLooks: 1, gamesPerBlock: 4,
});

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function invariant(condition, message) { if (!condition) throw new Error(message); }
function positiveInteger(value, name, allowZero = false) {
  invariant(Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1), name + ' must be a ' + (allowZero ? 'nonnegative' : 'positive') + ' integer.');
  return value;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function sourceHashes() {
  return Object.fromEntries([...strategySources(), 'tools/ai-product-sources.cjs', 'tools/ai-benchmark.cjs', 'doc/AI评测协议.md']
    .map(file => [file, sha256(fs.readFileSync(path.join(ROOT, file)))]));
}
function deriveSeed(...parts) { return sha256(canonical(parts)); }
function uint32Rng(seed) {
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  return function () {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}
function policyRng(seed) { const next = uint32Rng(seed); return () => next() / 4294967296; }
function diceRng(seed) {
  const next = uint32Rng(seed);
  return function () {
    let value;
    do { value = next(); } while (value >= 4294967292);
    return value % 6 + 1;
  };
}

function resolveConfig(overrides = {}) {
  invariant(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'Configuration must be a JSON object keyed by difficulty.');
  for (const level of Object.keys(overrides)) invariant(LEVELS.includes(level), 'Unknown configuration difficulty: ' + level);
  const defaults = AI.LEVEL_CONFIGS || {};
  return Object.fromEntries(LEVELS.map(level => {
    const supplied = overrides[level] === undefined ? {} : overrides[level];
    invariant(supplied && typeof supplied === 'object' && !Array.isArray(supplied), 'Difficulty configuration must be an object.');
    const config = { ...(defaults[level] || {}), ...supplied };
    for (const [key, value] of Object.entries(config)) {
      invariant(Object.hasOwn(defaults[level] || {}, key), 'Unknown configuration option for ' + level + ': ' + key);
      if (key === 'searchProfile') invariant(AI.ULTIMATE_SEARCH_PROFILES.includes(value), 'Unknown searchProfile.');
      else if (key === 'budgetMs') invariant(Number.isFinite(value) && value > 0, 'budgetMs must be positive and finite in the manifest.');
      else if (key === 'endgameBudgetMs') invariant(Number.isFinite(value) && value >= 0, 'endgameBudgetMs must be nonnegative and finite in the manifest.');
      else positiveInteger(value, key, key === 'maxDepth' || key === 'maxCacheEntries' || key === 'maxEndgameStates');
    }
    if (level === 'advanced' || level === 'ultimate') {
      for (const key of ['maxNodes', 'budgetMs', 'maxDepth', 'maxCacheEntries']) {
        invariant(Object.hasOwn(config, key), 'Missing ' + level + '.' + key + '; provide --config or implement AI.LEVEL_CONFIGS.');
      }
    }
    return [level, config];
  }));
}

function makeSchedule(spec) {
  const games = [];
  for (const pair of spec.pairs) {
    const [low, high] = pair.split('-');
    for (let block = 0; block < spec.blocks; block += 1) {
      const blockSeed = deriveSeed(VERSION, spec.mode, spec.seed, pair, block);
      // 四局复用同一条裁判骰序列，以实际掷骰时间顺序消费，不按玩家拆流。
      const judgeSeed = deriveSeed(blockSeed, 'judge-dice');
      for (let highPlayer = 0; highPlayer <= 1; highPlayer += 1) {
        for (let highStarts = 0; highStarts <= 1; highStarts += 1) {
          const slot = highPlayer * 2 + highStarts;
          const levels = highPlayer === 0 ? [high, low] : [low, high];
          games.push({
            id: pair + ':' + block + ':' + slot, pair, block, slot, blockSeed, judgeSeed,
            highPlayer, firstPlayer: highStarts ? highPlayer : 1 - highPlayer, levels,
            policySeeds: levels.map((level, player) => deriveSeed(blockSeed, 'policy', slot, level, player)),
          });
        }
      }
    }
  }
  return games;
}

function buildManifest(spec, dependencies = {}) {
  invariant(['development', 'validation', 'holdout'].includes(spec.mode), 'mode must be development, validation, or holdout.');
  invariant(['nodes', 'time'].includes(spec.execution), 'execution must be nodes or time.');
  invariant(typeof spec.seed === 'string' && spec.seed.length > 0, 'An explicit nonempty --seed is required.');
  positiveInteger(spec.blocks, 'blocks');
  positiveInteger(spec.maxRolls, 'maxRolls');
  invariant(Array.isArray(spec.pairs) && spec.pairs.length > 0 && new Set(spec.pairs).size === spec.pairs.length && spec.pairs.every(pair => PAIRS.includes(pair)), 'pairs must be distinct adjacent comparisons.');
  if (spec.mode === 'holdout') invariant(PAIRS.every(pair => spec.pairs.includes(pair)), 'A single formal holdout must pre-register all three comparisons.');
  const manifest = {
    schema: VERSION, createdAt: new Date().toISOString(), mode: spec.mode, execution: spec.execution,
    seed: spec.seed, pairs: spec.pairs, blocks: spec.blocks, maxRolls: spec.maxRolls,
    sources: dependencies.sources || sourceHashes(),
    versions: { ruleset: E.RULESET_ID, board: E.BOARD_VERSION, strategy: AI.STRATEGY_VERSION, evaluation: AI.EVALUATION_VERSION, levels: AI.LEVEL_VERSIONS, rng: RNG_VERSION },
    config: resolveConfig(spec.config), statistics: STATISTICS,
    cacheLifecycle: 'independent-per-decision',
    dicePairing: 'same-chronological-dice-stream-in-all-four-games-per-block',
    machine: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || 'unknown', logicalCpus: os.cpus().length },
    games: makeSchedule(spec),
  };
  return { ...manifest, id: sha256(canonical(manifest)) };
}

function verifyManifest(manifest, currentSources = sourceHashes()) {
  const { id, ...payload } = manifest;
  invariant(manifest.schema === VERSION, 'Unsupported manifest version.');
  invariant(id === sha256(canonical(payload)), 'Manifest content/hash mismatch; do not edit a frozen run.');
  invariant(canonical(manifest.sources) === canonical(currentSources), 'Source/protocol hashes changed; cannot mix revisions or resume this run. Create a new directory and preserve the previous run.');
  invariant(canonical(manifest.statistics) === canonical(STATISTICS), 'The pre-registered statistical method changed.');
  invariant(canonical(makeSchedule(manifest)) === canonical(manifest.games), 'Seed schedule does not match the manifest.');
  return true;
}

function appendDurably(file, row) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeFileSync(fd, JSON.stringify(row) + '\n', 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function loadCheckpoint(out, manifest, repairTail = false) {
  const file = path.join(out, 'games.jsonl');
  if (!fs.existsSync(file)) return [];
  const bytes = fs.readFileSync(file);
  const lastNewline = bytes.lastIndexOf(10);
  if (lastNewline !== bytes.length - 1) {
    invariant(repairTail, 'Checkpoint has an incomplete final line; run resumes it while preserving the partial bytes.');
    const tail = bytes.subarray(lastNewline + 1);
    const archivedName = 'checkpoint-tail.' + sha256(tail) + '.txt';
    fs.writeFileSync(path.join(out, archivedName), tail);
    appendDurably(path.join(out, 'recovery.jsonl'), { at: new Date().toISOString(), reason: 'interrupted-final-line', archivedName, bytes: tail.length });
    fs.truncateSync(file, lastNewline + 1);
  }
  const text = fs.readFileSync(file, 'utf8');
  const scheduled = new Map(manifest.games.map(game => [game.id, game]));
  const seen = new Set();
  const rows = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1 && line === '') continue;
    let row;
    try { row = JSON.parse(line); }
    catch { throw new Error('Corrupt checkpoint at line ' + (index + 1) + '; no data was discarded.'); }
    invariant(row.manifestId === manifest.id, 'Checkpoint belongs to a different manifest.');
    invariant(!seen.has(row.id), 'Duplicate checkpoint game: ' + row.id);
    invariant(scheduled.has(row.id), 'Unscheduled checkpoint game: ' + row.id);
    const game = scheduled.get(row.id);
    invariant(canonical(row.assignment) === canonical(game), 'Checkpoint seed/assignment mismatch: ' + row.id);
    invariant(['finished', 'truncated', 'error'].includes(row.status), 'Invalid checkpoint status.');
    invariant(row.recordHash === sha256(canonical({ ...row, recordHash: undefined })), 'Checkpoint record hash mismatch: ' + row.id);
    seen.add(row.id); rows.push(row);
  }
  return rows;
}

function emptyDiagnostics() { return { timesMs: [], nodes: 0, depths: {}, stopReasons: {}, cacheHits: 0, decisions: 0,
  exactDecisions: 0, endgameAttempts: 0, endgameFallbacks: 0 }; }
function runGame(manifest, game, runtime = { engine: E, ai: AI }) {
  const engine = runtime.engine;
  const ai = runtime.ai;
  const dice = diceRng(game.judgeSeed);
  const policies = game.policySeeds.map(policyRng);
  const decisions = Object.fromEntries(game.levels.map(level => [level, emptyDiagnostics()]));
  const trace = crypto.createHash('sha256');
  const started = performance.now();
  let state = engine.createGame(game.firstPlayer);
  let rolls = 0;
  let status = 'truncated';
  let failure = null;
  try {
    while (state.phase !== 'finished' && rolls < manifest.maxRolls) {
      const die = dice();
      trace.update('d' + die + ';');
      state = engine.applyRoll(state, die);
      rolls += 1;
      engine.validateState(state);
      if (state.phase === 'awaitingMove') {
        const player = state.activePlayer;
        const level = game.levels[player];
        const options = { ...manifest.config[level] };
        if (manifest.execution === 'nodes') {
          options.budgetMs = Infinity;
          if (Object.hasOwn(options, 'endgameBudgetMs') && options.endgameBudgetMs > 0) options.endgameBudgetMs = Infinity;
        }
        const snapshot = JSON.stringify(state);
        const decisionStart = performance.now();
        // AI 只收到公开快照、独立策略 RNG 和预算，不持有裁判 RNG 或未来骰点。
        const result = ai.chooseAction(state, level, policies[player], options);
        const metric = decisions[level];
        metric.timesMs.push(performance.now() - decisionStart);
        metric.decisions += 1;
        invariant(snapshot === JSON.stringify(state), 'AI mutated its public input state.');
        invariant(result && engine.getLegalActions(state).includes(result.action), 'AI returned an illegal action.');
        const diagnostic = result.diagnostics || {};
        metric.nodes += diagnostic.visitedNodes || 0;
        metric.cacheHits += diagnostic.cacheHits || 0;
        if (diagnostic.exact === true) metric.exactDecisions += 1;
        if (diagnostic.endgame?.attempted) {
          metric.endgameAttempts += 1;
          if (!diagnostic.endgame.complete) metric.endgameFallbacks += 1;
        }
        const depth = diagnostic.completedDepth || 0;
        metric.depths[depth] = (metric.depths[depth] || 0) + 1;
        const stopReason = diagnostic.stopReason || 'unreported';
        metric.stopReasons[stopReason] = (metric.stopReasons[stopReason] || 0) + 1;
        trace.update('a' + player + ':' + result.action + ';');
        state = engine.applyAction(state, result.action);
        engine.validateState(state);
      }
    }
    if (state.phase === 'finished') {
      engine.validateState(state);
      status = 'finished';
    } else failure = { reason: 'max-rolls', message: 'No real terminal result within the frozen roll limit.' };
  } catch (error) {
    status = 'error';
    failure = { reason: 'correctness-error', message: String(error.message), stack: String(error.stack) };
  }
  const row = {
    manifestId: manifest.id, id: game.id, assignment: game, status, rolls,
    winner: status === 'finished' ? state.winner : null,
    highScore: status === 'finished' ? Number(state.winner === game.highPlayer) : null,
    traceSha256: trace.digest('hex'), elapsedMs: performance.now() - started,
    decisions, finalState: state, failure, completedAt: new Date().toISOString(),
  };
  row.recordHash = sha256(canonical({ ...row, recordHash: undefined }));
  return row;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function timing(values) {
  return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.length ? values.reduce((a, b) => Math.max(a, b), 0) : null };
}
function blockInterval(scores) {
  if (!scores.length) return { blocks: 0, mean: null, lowerBound: null, radius: null };
  invariant(scores.every(score => Number.isFinite(score) && score >= 0 && score <= 1), 'Block scores must lie in [0, 1].');
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const radius = Math.sqrt(Math.log(1 / STATISTICS.alphaPerPair) / (2 * scores.length));
  return { blocks: scores.length, mean, lowerBound: Math.max(0, mean - radius), radius };
}
function summarize(manifest, rows) {
  const allRecorded = rows.length === manifest.games.length;
  const hideScores = manifest.mode === 'holdout' && !allRecorded;
  const pairs = {};
  const metrics = {};
  for (const pair of manifest.pairs) {
    const matched = rows.filter(row => row.assignment.pair === pair);
    const finished = matched.filter(row => row.status === 'finished');
    const wins = finished.reduce((sum, row) => sum + row.highScore, 0);
    const scores = [];
    for (let block = 0; block < manifest.blocks; block += 1) {
      const set = matched.filter(row => row.assignment.block === block);
      if (set.length === 4 && set.every(row => row.status === 'finished')) scores.push(set.reduce((sum, row) => sum + row.highScore, 0) / 4);
    }
    const interval = blockInterval(scores);
    const complete = finished.length === manifest.blocks * 4;
    const thresholdMet = complete && interval.mean >= STATISTICS.observedRateMinimum && interval.lowerBound > STATISTICS.lowerBoundExclusiveMinimum;
    pairs[pair] = {
      requestedGames: manifest.blocks * 4, recordedGames: matched.length, finishedGames: finished.length,
      errors: matched.filter(row => row.status === 'error').length,
      truncated: matched.filter(row => row.status === 'truncated').length,
      ...(hideScores ? { scoresHiddenUntilPlannedEnd: true } : {
        highWins: wins, highLosses: finished.length - wins,
        observedRateFinishedGames: finished.length ? wins / finished.length : null,
        blockStatistics: interval, thresholdsMet: thresholdMet,
        // 尚未记录、错误和截断均纳入上下界，不借删除未完成局抬高结论。
        sensitivityAcrossAllPlannedGames: { allUnfinishedLose: wins / (manifest.blocks * 4), allUnfinishedWin: (wins + manifest.blocks * 4 - finished.length) / (manifest.blocks * 4) },
        statisticalAcceptance: manifest.mode === 'holdout' && thresholdMet,
      }),
    };
    for (const row of matched) for (const [level, d] of Object.entries(row.decisions)) {
      if (!metrics[level]) metrics[level] = emptyDiagnostics();
      const total = metrics[level];
      total.timesMs.push(...d.timesMs); total.nodes += d.nodes; total.decisions += d.decisions; total.cacheHits += d.cacheHits;
      total.exactDecisions += d.exactDecisions || 0; total.endgameAttempts += d.endgameAttempts || 0;
      total.endgameFallbacks += d.endgameFallbacks || 0;
      for (const [depth, count] of Object.entries(d.depths)) total.depths[depth] = (total.depths[depth] || 0) + count;
      for (const [reason, count] of Object.entries(d.stopReasons)) total.stopReasons[reason] = (total.stopReasons[reason] || 0) + count;
    }
  }
  return {
    manifestId: manifest.id, purpose: manifest.mode, execution: manifest.execution,
    statistics: STATISTICS, plannedGames: manifest.games.length, recordedGames: rows.length,
    allRecorded, strengthAcceptance: manifest.mode === 'holdout' && PAIRS.every(pair => pairs[pair]?.statisticalAcceptance === true),
    fourLevelReleaseAcceptance: false,
    limitation: 'This report covers headless strength/correctness only. Development and validation are not holdout proof. Browser latency, Worker recovery, and compatibility require separate evidence; time-mode actions can depend on device load.',
    pairs, decisionMetrics: Object.fromEntries(Object.entries(metrics).map(([level, d]) => [level, { ...d, timesMs: undefined, timingMs: timing(d.timesMs) }])),
    gameTimingMs: timing(rows.map(row => row.elapsedMs)),
    totalRecordedComputeMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
  };
}

function estimate(manifest, rows, targetBlocks) {
  positiveInteger(targetBlocks, 'target-blocks');
  return {
    basis: 'Measured completed attempts at the frozen configuration; sequential CPU cost, excluding animation and browser startup. Twofold reserve is planning slack, not a confidence interval.',
    targetBlocksPerPair: targetBlocks,
    pairs: Object.fromEntries(manifest.pairs.map(pair => {
      const matched = rows.filter(row => row.assignment.pair === pair);
      const average = matched.length ? matched.reduce((sum, row) => sum + row.elapsedMs, 0) / matched.length : null;
      const hours = average === null ? null : average * targetBlocks * 4 / 3600000;
      return [pair, { measuredGames: matched.length, meanGameMs: average, targetGames: targetBlocks * 4, estimatedSequentialHours: hours, planningReserveHours: hours === null ? null : hours * 2 }];
    })),
  };
}

function lockDirectory(out) {
  const file = path.join(out, 'run.lock');
  if (fs.existsSync(file)) {
    const old = readJson(file);
    invariant(old.hostname === os.hostname(), 'Run directory is locked by another host.');
    let alive = true;
    try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    invariant(!alive, 'Run directory is in use by process ' + old.pid + '.');
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() }), 'utf8');
  fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}

function parseArgs(argv) {
  const command = argv.shift() || 'help';
  const options = {};
  while (argv.length) {
    const key = argv.shift();
    invariant(key.startsWith('--') && argv.length && !argv[0].startsWith('--'), 'Expected --name value: ' + key);
    invariant(!Object.hasOwn(options, key.slice(2)), 'Repeated option: ' + key);
    options[key.slice(2)] = argv.shift();
  }
  return { command, options };
}
const HELP = `Ludo AI benchmark (Node, no dependencies)
  init --out DIR --mode development|validation|holdout --seed TEXT --blocks N
       [--pairs beginner-medium,medium-advanced,advanced-ultimate]
       [--execution nodes|time] [--config FILE.json] [--max-rolls 10000]
  run --out DIR [--max-games N] [--max-seconds N]
  report --out DIR
  estimate --out DIR [--target-blocks 400]

init freezes source hashes, full seed schedule, resolved product budgets and method.
run resumes only identical sources; each finished/error/truncated game is durable.
Use separate output directories to run different pairs concurrently. One writer per directory.
nodes disables search/endgame wall-clock cutoff only; node/depth/cache/endgame-state quotas remain frozen.
time retains the product time protection and is not bitwise deterministic across devices.
No run is started by init. Partial holdout reports withhold win/loss statistics.
`;

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv.slice());
  if (command === 'help') { process.stdout.write(HELP); return; }
  const allowed = {
    init: ['out', 'mode', 'seed', 'blocks', 'pairs', 'execution', 'config', 'max-rolls'],
    run: ['out', 'max-games', 'max-seconds'], report: ['out'], estimate: ['out', 'target-blocks'],
  };
  invariant(allowed[command], 'Unknown command: ' + command);
  for (const key of Object.keys(options)) invariant(allowed[command].includes(key), 'Unknown option --' + key);
  invariant(options.out, '--out is required.');
  const out = path.resolve(options.out);
  if (command === 'init') {
    invariant(!fs.existsSync(out) || fs.readdirSync(out).length === 0, 'Output directory must be new or empty; existing runs are never overwritten.');
    const manifest = buildManifest({
      mode: options.mode || 'development', execution: options.execution || 'nodes', seed: options.seed,
      blocks: Number(options.blocks), pairs: options.pairs ? options.pairs.split(',') : PAIRS.slice(),
      maxRolls: Number(options['max-rolls'] || 10000), config: options.config ? readJson(path.resolve(options.config)) : {},
    });
    fs.mkdirSync(out, { recursive: true });
    writeJson(path.join(out, 'manifest.json'), manifest);
    process.stdout.write(JSON.stringify({ initialized: out, manifestId: manifest.id, games: manifest.games.length, purpose: manifest.mode }) + '\n');
    return;
  }
  const manifest = readJson(path.join(out, 'manifest.json'));
  // report/estimate也核对当前源码，避免在新版代码下误读成新版证据。
  verifyManifest(manifest);
  if (command !== 'run') {
    const rows = loadCheckpoint(out, manifest);
    const report = command === 'report' ? summarize(manifest, rows) : estimate(manifest, rows, Number(options['target-blocks'] || 400));
    writeJson(path.join(out, command + '.json'), report);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const maxGames = options['max-games'] ? positiveInteger(Number(options['max-games']), 'max-games') : Infinity;
  const maxSeconds = options['max-seconds'] ? Number(options['max-seconds']) : Infinity;
  invariant(maxSeconds > 0, 'max-seconds must be positive.');
  const release = lockDirectory(out);
  let stop = false;
  const signalHandler = () => { stop = true; };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);
  try {
    const rows = loadCheckpoint(out, manifest, true);
    const done = new Set(rows.map(row => row.id));
    const started = performance.now();
    let added = 0;
    for (const game of manifest.games) {
      if (done.has(game.id)) continue;
      if (stop || added >= maxGames || performance.now() - started >= maxSeconds * 1000) break;
      const row = runGame(manifest, game);
      appendDurably(path.join(out, 'games.jsonl'), row);
      rows.push(row); added += 1;
      process.stdout.write(JSON.stringify({ recordedGames: rows.length, plannedGames: manifest.games.length, id: game.id, status: row.status, gameSeconds: Number((row.elapsedMs / 1000).toFixed(2)) }) + '\n');
      await new Promise(resolve => setImmediate(resolve));
    }
    const report = summarize(manifest, rows);
    writeJson(path.join(out, 'report.json'), report);
    process.stdout.write(JSON.stringify({ manifestId: manifest.id, addedGames: added, recordedGames: rows.length, plannedGames: manifest.games.length, report: path.join(out, 'report.json') }) + '\n');
    if (rows.some(row => row.status !== 'finished')) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    release();
  }
}

module.exports = { VERSION, STATISTICS, PAIRS, canonical, sha256, deriveSeed, diceRng, policyRng, makeSchedule, sourceHashes, resolveConfig, buildManifest, verifyManifest, runGame, blockInterval, summarize, estimate, loadCheckpoint, appendDurably, main };
if (require.main === module) main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
