'use strict';

// 固定归家局面核对：比较旧策略选招与精确终局概率，不能替代整局胜率测试。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const E = require('../src/engine.js');
const Exact = require('../src/ai-v2-endgame.js');
const Old = require('../tests/fixtures/ai-v1/ai.js');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', 'ultimate-v2', 'endgame-audit.json');
const rng = Old.createSeededRng('ultimate-v2-home-audit-v1');
const cases = [], startedAt = new Date().toISOString();
for (let attempt = 0; cases.length < 48 && attempt < 2000; attempt++) {
  const state = E.createGame(attempt % 2);
  state.tokenProgress = [0, 1].map(() => {
    const count = attempt % 6 === 0 ? 3 : 2;
    return Array.from({ length: 4 }, (_, index) => index < count ? 52 + Math.floor(rng() * 4) : E.FINISH);
  });
  state.consecutiveSixes = attempt % 3;
  const rolled = E.applyRoll(state, 1 + Math.floor(rng() * 3));
  if (rolled.phase !== 'awaitingMove') continue;
  const unique = new Set(E.getLegalActions(rolled).map(action => E.stateKey(E.applyAction(rolled, action), { canonicalTokens: true })));
  if (unique.size < 2) continue;
  const begun = performance.now();
  const exact = Exact.analyze(rolled, { budgetMs: Infinity, maxStates: 24000 });
  if (!exact.complete) throw new Error('Predetermined small endgame exceeded state limit.');
  const byChild = new Map(exact.diagnostics.rootProbabilities.map(candidate => [E.stateKey(E.applyAction(rolled, candidate.action), { canonicalTokens: true }), candidate.probability]));
  const baselines = {};
  for (const level of ['advanced', 'ultimate']) {
    const choice = Old.chooseAction(rolled, level, () => .5, { budgetMs: Infinity });
    const probability = byChild.get(E.stateKey(E.applyAction(rolled, choice.action), { canonicalTokens: true }));
    if (probability === undefined) throw new Error('Baseline selected an invalid successor.');
    const regret = exact.probability - probability;
    if (regret < -1e-10) throw new Error('Baseline beat claimed exact root optimum.');
    baselines[level] = { action: choice.action, probability, regret: Math.max(0, regret), completedDepth: choice.diagnostics.completedDepth };
  }
  cases.push({ id: cases.length, state: rolled, optimalAction: exact.action, optimalProbability: exact.probability, rootProbabilities: exact.diagnostics.rootProbabilities, baselines, elapsedMs: performance.now() - begun });
  if (cases.length % 12 === 0) console.log(JSON.stringify({ completed: cases.length, planned: 48 }));
}
if (cases.length !== 48) throw new Error('Fixture construction did not reach the planned count.');
const summary = Object.fromEntries(['advanced', 'ultimate'].map(level => {
  const values = cases.map(item => item.baselines[level].regret);
  return [level, { cases: cases.length, optimal: values.filter(value => value <= 1e-10).length, suboptimal: values.filter(value => value > 1e-10).length, meanRegret: values.reduce((sum, value) => sum + value, 0) / values.length, maxRegret: Math.max(...values) }];
}));
const files = ['src/engine.js', 'src/ai-v2-endgame.js', 'tests/fixtures/ai-v1/ai.js', 'tests/fixtures/ai-v1/engine.js', 'tools/ultimate-endgame-audit.cjs'];
const report = { version: 'fixed-home-position-audit@1', startedAt, completedAt: new Date().toISOString(), seed: 'ultimate-v2-home-audit-v1', count: 48,
  limitation: 'Conditional two/three-token home-lane decisions. Regret is loss of win probability assuming optimal continuation by both sides, not an empirical whole-game win rate. Unlimited time is used to compare node/state-limited logic; timing is not browser performance.',
  sourceHashes: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])), summary, cases };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ out, summary }));
