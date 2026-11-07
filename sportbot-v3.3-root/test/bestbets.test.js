'use strict';
const assert = require('assert');
const A = require('../services/analyticsEngine');
const { pickBestBets, evaluateProp, propLean } = A;

const bet = (id, label, p, pModel, pMkt, ev, dec = 1.8) => ({ type: 'ML', gameId: id, label, p, pModel, pMkt, ev, dec, american: -125, book: 'x', tier: {} });
const analyses = [
  { reliable: true, bets: [bet('g1', 'Coinflip +EV', 0.53, 0.55, 0.52, 0.08, 2.1)] },                 // old ranking favourite
  { reliable: true, bets: [bet('g2', 'Heavy fav', 0.72, 0.74, 0.71, -0.01, 1.4)] },
  { reliable: true, bets: [bet('g3', 'Model-only edge', 0.60, 0.70, 0.55, 0.05, 1.9)] },              // |model-mkt| < .2 but ok
  { reliable: true, bets: [bet('g4', 'Disagree', 0.62, 0.45, 0.70, 0.02, 1.5)] },                    // model leans other way -> out
  { reliable: false, bets: [bet('g5', 'Unreliable', 0.80, 0.8, 0.8, 0.1)] },
];
let out = pickBestBets(analyses, 5, []);
assert.deepStrictEqual(out.map(b => b.label), ['Heavy fav', 'Model-only edge']);

// Props: the more probable side wins and the last 10 must back it
const mk = (line, last10) => {
  const e = evaluateProp({ proj: 27, sd: 8, line, over: null, under: null, last10Scores: last10 });
  return { type: 'PROP', player: 'P', team: 'T', stat: 'points', line, estimated: true, questionable: false, avg: 26, proj: 27, ...e };
};
const good = mk(22.5, [28, 25, 30, 24, 26, 27, 23, 29, 31, 25]);   // 10/10 over
const weak = mk(22.5, [20, 18, 30, 15, 26, 21, 23, 19, 31, 17]);   // L10 does not back the over
assert.strictEqual(propLean(good).side, 'Over');
out = pickBestBets([], 5, [good]);
assert.strictEqual(out.length, 1);
assert.ok(out[0].p >= 0.60);
assert.strictEqual(pickBestBets([], 5, [weak]).length, 0);

// ---- H2H is derived from schedules and only the residual vs the ratings is applied ----
const side = (p, f, a) => ({ gp: 20, winPct: p, avgFor: f, avgAgainst: a, l10Pct: p, streak: 0, name: 'x' });
const g = (daysAgo, home, margin) => ({ t: Date.now() - daysAgo * 864e5, home, neutral: false, opp: 'Miami Heat', completed: true, pf: 100 + margin, pa: 100, margin, win: margin > 0 });
const base = { standings: { byName: { 'boston celtics': side(0.6, 114, 110), 'miami heat': side(0.6, 114, 110) }, league: { avgFor: 114, avgAgainst: 114 } },
  injuries: { byTeam: {} }, scoreboard: { byTeam: {} } };
const gm = { id: 'g', home: 'Boston Celtics', away: 'Miami Heat', commenceTime: new Date(Date.now() + 864e5).toISOString(),
  ml: { fairHome: 0.6, fairAway: 0.4, home: { american: -150, dec: 1.667, book: 'T' }, away: { american: 130, dec: 2.3, book: 'T' } } };
const none = A.analyzeGame('nba', gm, base, 0);
const dom = A.analyzeGame('nba', gm, { ...base, schedule: { byTeam: { 'boston celtics': [g(30, true, 15), g(60, false, 12)] } } }, 0);
const lose = A.analyzeGame('nba', gm, { ...base, schedule: { byTeam: { 'boston celtics': [g(30, true, -15), g(60, false, -12)] } } }, 0);
assert.strictEqual(none.h2hAdj, 0);
assert.ok(dom.h2hAdj > 0 && lose.h2hAdj < 0, 'H2H should move the projection in the right direction');
assert.ok(dom.pHomeModel > none.pHomeModel && lose.pHomeModel < none.pHomeModel);
assert.strictEqual(dom.h2h.n, 2);
console.log('bestbets tests passed.');
