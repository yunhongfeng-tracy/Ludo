'use strict';

// 开发集冒烟，检查真实终局、合法性和吞吐；不构成四档强度验收。
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const E = require('../src/engine.js');
const AI = require('../src/ai.js');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}
const games = argument('games', 100);
const maxRolls = argument('max-rolls', 10000);
const baseSeed = argument('seed', 7311901);
if (![games, maxRolls, baseSeed].every(Number.isSafeInteger) || games <= 0 || maxRolls <= 0 || baseSeed < 0) {
  throw new Error('参数必须为合法整数，games和max-rolls应为正数。');
}

const report = {
  purpose: 'development-smoke-only',
  strengthAcceptance: false,
  limitation: '仅初级和中级开发集冒烟，未运行留出集或四档相邻强度检验。',
  rulesetId: E.createGame(0).rulesetId,
  boardVersion: E.createGame(0).boardVersion,
  baseSeed,
  requestedGames: games,
  maxRollsPerGame: maxRolls,
  completed: 0,
  truncated: 0,
  errors: 0,
  wins: { beginner: 0, medium: 0 },
  rolls: 0,
  decisions: 0,
  failedGames: [],
};
const decisionTimes = { beginner: [], medium: [] };
const started = performance.now();
for (let game = 0; game < games; game += 1) {
  // 骰源不传入AI；策略随机流采用不同的派生值且各自独立。
  const diceSeed = (baseSeed + Math.imul(game + 1, 0x9e3779b9)) >>> 0;
  const diceRng = AI.createSeededRng(diceSeed);
  const choiceRng = [AI.createSeededRng(diceSeed ^ 0xa5a5f00d), AI.createSeededRng(diceSeed ^ 0x3c6ef372)];
  const levels = game % 2 ? ['beginner', 'medium'] : ['medium', 'beginner'];
  let state = E.createGame(Math.floor(game / 2) % 2);
  let rolls = 0;
  try {
    while (state.phase !== 'finished' && rolls < maxRolls) {
      state = E.applyRoll(state, Math.floor(diceRng() * 6) + 1);
      rolls += 1;
      E.validateState(state);
      if (state.phase === 'awaitingMove') {
        const player = state.activePlayer;
        const snapshot = JSON.stringify(state);
        const decisionStart = performance.now();
        const decision = AI.chooseAction(state, levels[player], choiceRng[player]);
        decisionTimes[levels[player]].push(performance.now() - decisionStart);
        report.decisions += 1;
        assert.equal(JSON.stringify(state), snapshot, 'AI改变了真实输入');
        assert.ok(E.getLegalActions(state).includes(decision.action), 'AI返回非法动作');
        state = E.applyAction(state, decision.action);
        E.validateState(state);
      }
    }
    report.rolls += rolls;
    if (state.phase === 'finished') {
      assert.ok(state.winner === 0 || state.winner === 1);
      assert.ok(state.tokenProgress[state.winner].every(progress => progress === E.FINISH));
      report.completed += 1;
      report.wins[levels[state.winner]] += 1;
    } else {
      report.truncated += 1;
      report.failedGames.push({ game, diceSeed, levels, rolls, reason: 'roll-limit', state });
    }
  } catch (error) {
    report.errors += 1;
    report.failedGames.push({ game, diceSeed, levels, rolls, reason: error.stack, state });
  }
}
function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
}
report.elapsedMs = Number((performance.now() - started).toFixed(3));
report.completionRate = report.completed / games;
report.decisionTimingMs = {};
for (const level of ['beginner', 'medium']) {
  const sorted = decisionTimes[level].sort((a, b) => a - b);
  report.decisionTimingMs[level] = {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.errors > 0 || report.truncated > 0) process.exitCode = 1;
