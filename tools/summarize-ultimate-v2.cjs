'use strict';
// 汇总不同用途的固定批次，不把开发、验证、限时核对或同种子重放合并成胜率。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Lab = require('./ultimate-lab.cjs');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const specifications = [
  ...['classic60', 'budget180', 'search60', 'search120', 'rollout64', 'rollout256', 'hybrid60'].map(name => ['ultimate-v2-dev-' + name, 'development', 32]),
  ...['advanced', 'ultimate'].map(name => ['ultimate-v2-validation-' + name, 'independent-validation', 64]),
  ...['advanced', 'ultimate'].map(name => ['ultimate-v2-time-' + name, 'time-budget-check', 16]),
  ['ultimate-v2-time-ultimate-node-replay', 'same-seed-diagnostic-replay', 16]
];
const batches = specifications.map(([name, purpose, expectedGames]) => {
  const folder = 'output/' + name;
  const manifest = read(folder + '/manifest.json'), report = read(folder + '/report.json');
  Lab.verifyManifest(manifest);
  const blocks = Lab.loadCheckpoint(path.join(root, folder), manifest);
  const games = blocks.flatMap(block => block.games);
  assert.equal(games.length, expectedGames); assert.equal(report.recordedGames, expectedGames);
  assert.equal(report.finishedGames, expectedGames); assert.equal(report.errors, 0); assert.equal(report.truncated, 0);
  assert.equal(games.reduce((sum, game) => sum + game.candidateScore, 0), report.candidateWins);
  return { name, purpose, execution: report.execution, report: folder + '/report.json', manifestId: manifest.id,
    games: expectedGames, wins: report.candidateWins, losses: report.candidateLosses,
    observedRate: report.observedRateFinishedGames, errors: report.errors, truncated: report.truncated,
    statisticalAcceptance: report.statisticalAcceptance, blockLowerBound: report.blockStatistics.lowerBound };
});
const timeManifest = read('output/ultimate-v2-time-ultimate/manifest.json');
const replayManifest = read('output/ultimate-v2-time-ultimate-node-replay/manifest.json');
assert.deepEqual(timeManifest.games, replayManifest.games);
assert.deepEqual(timeManifest.agents, replayManifest.agents);
const loadGames = name => Lab.loadCheckpoint(path.join(root, 'output', name), read('output/' + name + '/manifest.json')).flatMap(block => block.games).sort((a, b) => a.id.localeCompare(b.id));
const timeGames = loadGames('ultimate-v2-time-ultimate'), replayGames = loadGames('ultimate-v2-time-ultimate-node-replay');
const replayComparison = timeGames.map((game, index) => {
  const other = replayGames[index]; assert.equal(game.id, other.id);
  return { id: game.id, winnerUnchanged: game.winner === other.winner, traceUnchanged: game.traceSha256 === other.traceSha256,
    timeScore: game.candidateScore, nodeScore: other.candidateScore, timeRolls: game.rolls, nodeRolls: other.rolls };
});
const summary = { createdAt: new Date().toISOString(), version: read('package.json').version,
  totalGameExecutions: batches.reduce((sum, batch) => sum + batch.games, 0),
  diagnosticReplayExecutions: 16, formalHoldoutStarted: false, fourLevelStrengthAccepted: false,
  reason: 'Independent validation against advanced was 34/64, below the preregistered 55% entry gate. Time samples and same-seed replays cannot rescue or increase that validation sample.',
  limitation: 'Counts describe executions, not independent games. Blocks and reused seeds create dependence. Never pool wins across these purposes. Replay removes deadlines for BOTH agents; trace hashes alone cannot attribute changes to one agent.',
  batches, replayComparison, sameWinnerGames: replayComparison.filter(game => game.winnerUnchanged).length,
  sameTraceGames: replayComparison.filter(game => game.traceUnchanged).length,
  release: read('output/deploy/ultimate-v2-public-check.json') };
fs.writeFileSync(path.join(root, 'output/ultimate-v2/summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ executions: summary.totalGameExecutions, sameWinnerGames: summary.sameWinnerGames, sameTraceGames: summary.sameTraceGames, batches: batches.map(({ name, wins, losses }) => ({ name, wins, losses })) }));
