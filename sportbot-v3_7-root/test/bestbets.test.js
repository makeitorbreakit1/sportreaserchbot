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
assert.deepStrictEqual(out.map(b => b.label), ['Model-only edge', 'Coinflip +EV'], 'v3.6: must beat its price; heavy favourites (-250) and model-vs-market disagreements are out');

// Props: only REAL sportsbook lines (both sides priced) can become picks, and they must have a real edge
const pr = (am) => ({ american: am, dec: A.americanToDecimal(am), book: 'DK' });
const mk = (line, last10, over = pr(-130), under = pr(110)) => {
  const e = evaluateProp({ proj: 27, sd: 8, line, over, under, last10Scores: last10 });
  return { type: 'PROP', player: 'P', team: 'T', stat: 'points', line, estimated: false, questionable: false, avg: 26, proj: 27, ...e };
};
const good = mk(24.5, [28, 25, 30, 24, 26, 27, 23, 29, 31, 25]);   // 8/10 over a real 24.5, priced -130/+110
const weak = mk(24.5, [20, 18, 30, 15, 26, 21, 23, 19, 31, 17]);  // L10 does not back it
assert.strictEqual(propLean(good).side, 'Over');
out = pickBestBets([], 5, [good]);
assert.strictEqual(out.length, 1);
assert.ok(out[0].ev >= 0.03 && out[0].p <= 0.72 && out[0].dec >= 1.6);
assert.strictEqual(pickBestBets([], 5, [weak]).length, 0);

// v3.6 regression: made-up lines are NEVER picks (Giannis over 5.5 REB / Ware over 2.5 REB at a fake -110)
const fake = (() => {
  const e = evaluateProp({ proj: 11, sd: 4.4, line: 5.5, over: null, under: null, last10Scores: [12, 10, 14, 11, 9, 13, 12, 10, 15, 11] });
  return { type: 'PROP', player: 'Giannis', team: 'T', stat: 'rebounds', line: 5.5, estimated: true, questionable: false, avg: 11, proj: 11, ...e };
})();
assert.strictEqual(fake.priced, false); assert.strictEqual(fake.american, null); assert.strictEqual(fake.dec, null); assert.strictEqual(fake.ev, 0);
assert.strictEqual(pickBestBets([], 5, [fake]).length, 0, 'an unpriced/estimated prop can never be a pick');
// even with a real market, a line this far from the projection is flagged as suspect data and skipped
assert.strictEqual(pickBestBets([], 5, [{ ...mk(24.5, [28, 25, 30, 24, 26, 27, 23, 29, 31, 25]), suspect: true }]).length, 0);
// and a real line with no value (priced -1000/+650 on a "sure thing") is not a bet either
assert.strictEqual(pickBestBets([], 5, [mk(10.5, [28, 25, 30, 24, 26, 27, 23, 29, 31, 25], pr(-1000), pr(650))]).length, 0, 'no heavy-juice props');

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

// ---- v3.4: market anchoring, last-10 guards, realistic prop lines, slip ----
const mkSide = (pct, f, a) => ({ gp: 20, winPct: pct, avgFor: f, avgAgainst: a, l10Pct: pct, streak: 0 });
const sch = (pf, pa) => Array.from({ length: 12 }, (_, i) => ({ t: Date.now() - (i + 2) * 2 * 864e5, home: i % 2 === 0, neutral: false, opp: 'Z', completed: true, pf, pa, margin: pf - pa, win: pf > pa }));
const price = (am, dec) => ({ american: am, dec, book: 'T' });
const hornetsGame = { id: 'h1', home: 'Boston Celtics', away: 'Charlotte Hornets', commenceTime: new Date(Date.now() + 864e5).toISOString(),
  ml: { fairHome: 0.82, fairAway: 0.18, home: price(-450, 1.22), away: price(360, 4.6) },
  spread: { point: -8.5, fairHome: 0.5, home: price(-110, 1.909), away: price(-110, 1.909) },
  total: { point: 225.5, fairOver: 0.5, over: price(-110, 1.909), under: price(-110, 1.909) } };
const hctx = { standings: { byName: { 'boston celtics': mkSide(0.8, 119, 108), 'charlotte hornets': mkSide(0.25, 107, 118) }, league: { avgFor: 113, avgAgainst: 113 } },
  injuries: { byTeam: {} }, scoreboard: { byTeam: {} }, schedule: { byTeam: { 'boston celtics': sch(120, 108), 'charlotte hornets': sch(106, 117) } } };
const hn = A.analyzeGame('nba', hornetsGame, hctx, 0);
assert.ok(hn.l10Margin > 12, 'last-10 points should show a big Celtics edge');
assert.ok(Math.abs(hn.projMargin - hn.mktMargin) < Math.abs(hn.histMargin - hn.mktMargin) + 1e-9, 'projection is anchored toward the market');
const hp = A.pickBestBets([hn], 5, []);
assert.ok(!hp.some(b => b.type === 'SPREAD' && b.side === 'away'), 'no Hornets +8.5 when the last 10 says they get blown out');

const dogBet = { type: 'SPREAD', gameId: 'x', side: 'away', team: 'Dog', line: 8.5, label: 'Dog +8.5', p: 0.6, pModel: 0.6, pMkt: 0.5, ev: 0, dec: 1.91, american: -110, book: 'T' };
const dogA = (l10) => ({ reliable: true, sport: 'nba', histMargin: 5, l10Margin: 5, game: { spread: { point: -8.5 } },
  home: { sched: { l10: { rawMargin: 8 } } }, away: { sched: { l10: { rawMargin: l10 } } }, bets: [dogBet] });
assert.strictEqual(A.pickBestBets([dogA(-9)], 5, []).length, 0, 'big dog that loses by 9 a night is blocked');
assert.strictEqual(A.pickBestBets([dogA(-3)], 5, []).length, 1, 'same pick is allowed when the dog is competitive');

// (legacy helper, no longer used for picks)
const sl = A.safeLineFor({ proj: 26, sd: 7.8, scores: [28, 25, 30, 24, 26, 27, 23, 29, 31, 25] });
assert.ok(sl && sl.line <= 21.5 && sl.line >= 17.5 && sl.pModel >= 0.78 && sl.hits / sl.n >= 0.8);
assert.strictEqual(A.safeLineFor({ proj: 26, sd: 7.8, scores: [10, 12, 30, 9, 26, 11, 23, 8, 31, 12] }), null, 'inconsistent scorer gets no safe line');

// slip: singles for the best picks, one 2-leg parlay from different games
const lg = (id, p, dec, est = false) => ({ gameId: id, label: id, p, dec, estimated: est });
const slip = A.buildSlip([lg('a', 0.72, 1.5), lg('a', 0.70, 1.6), lg('b', 0.66, 1.7), lg('c', 0.58, 2)]);
assert.strictEqual(slip.straights.length, 3);
assert.deepStrictEqual(slip.parlay.legs.map(b => b.gameId), ['a', 'b']);
assert.ok(Math.abs(slip.parlay.p - 0.72 * 0.66) < 1e-9 && Math.abs(slip.parlay.dec - 1.5 * 1.7) < 1e-9);
assert.strictEqual(A.buildSlip([lg('a', 0.7, 1.5, true), lg('b', 0.7, 1.5, true)]).parlay.dec, null, 'alt-line legs have no real price');

// ---- classic mode reproduces the ORIGINAL model and rule ----
const gpN = 20, K = 15;                                   // original NBA shrink constant
const orig = (st) => (st.avgFor - st.avgAgainst) * gpN / (gpN + K) + Math.max(-3, Math.min(3, (st.l10Pct - st.winPct) * 8)) * gpN / (gpN + K);
const cH = hctx.standings.byName['boston celtics'], cA = hctx.standings.byName['charlotte hornets'];
const expectMargin = orig(cH) + 2.6 - orig(cA);
const noSched = { ...hctx, schedule: undefined };
const c1 = A.analyzeGame('nba', hornetsGame, noSched, null, { classic: true });
const c2 = A.analyzeGame('nba', hornetsGame, hctx, null, { classic: true });       // with schedules present
assert.ok(Math.abs(c1.projMargin - expectMargin) < 1e-9, 'classic projection equals the original formula');
assert.ok(Math.abs(c2.projMargin - expectMargin) < 1e-9, 'classic ignores last-10 / rest / venue data');
assert.ok(!c1.bets.some(b => b.type === 'TOTAL'), 'original had no totals');
const w = 0.35, mlh = c1.bets.find(b => b.type === 'ML' && b.side === 'home');
assert.ok(Math.abs(mlh.p - (w * mlh.pModel + (1 - w) * mlh.pMkt)) < 1e-9, 'classic probability is 35% model / 65% market');

const cb = (id, type, ev, p, pModel, pMkt, dec = 1.9) => ({ type, gameId: id, ev, p, pModel, pMkt, dec, label: id });
const cl = A.pickBestBetsClassic([
  { reliable: true, game: { id: 'a' }, bets: [cb('a', 'ML', 0.02, 0.60, 0.62, 0.59), cb('a', 'SPREAD', 0.05, 0.55, 0.6, 0.5)] },
  { reliable: true, game: { id: 'b' }, bets: [cb('b', 'ML', 0.03, 0.52, 0.55, 0.51, 2.5)] },          // price over +130: out
  { reliable: true, game: { id: 'c' }, bets: [cb('c', 'ML', 0.03, 0.58, 0.9, 0.5)] },                  // model/market gap > 20 pts: out
  { reliable: true, game: { id: 'd' }, bets: [cb('d', 'TOTAL', 0.05, 0.6, 0.6, 0.55)] },               // totals are not in classic
  { reliable: true, game: { id: 'e' }, bets: [cb('e', 'ML', 0.005, 0.6, 0.6, 0.6)] },                  // under 1% EV: out
], 5);
assert.deepStrictEqual(cl.map(b => b.gameId), ['a'], 'one pick per game, original filters');
assert.strictEqual(cl[0].type, 'SPREAD', 'ranked by EV + 0.3*(p-0.5), exactly like the original');

// ---- v3.6: game lines must beat the posted price and avoid locks / lottery tickets ----
const gb = (id, o) => ({ reliable: true, bets: [{ type: 'ML', gameId: id, label: id, p: 0, pModel: 0.6, pMkt: 0.55, ev: 0, dec: 1.9, american: -110, book: 'x', ...o }] });
assert.strictEqual(pickBestBets([gb('lock', { pModel: 0.9, pMkt: 0.88, dec: 1.1 })], 5, []).length, 0, 'a -1000 lock is not a bet');
assert.strictEqual(pickBestBets([gb('lotto', { pModel: 0.5, pMkt: 0.5, dec: 5 })], 5, []).length, 0, 'no +400 lottery tickets');
assert.strictEqual(pickBestBets([gb('fair', { pModel: 0.52, pMkt: 0.52, dec: 1.9 })], 5, []).length, 0, 'fairly priced = no edge = no pick');
assert.strictEqual(pickBestBets([gb('mirage', { pModel: 0.75, pMkt: 0.5, dec: 1.9 })], 5, []).length, 0, 'a 25-pt model/market gap is bad data, not an edge');
assert.strictEqual(pickBestBets([gb('real', { pModel: 0.60, pMkt: 0.54, dec: 1.95 })], 5, []).length, 1, 'a modest, believable edge at a real price is a pick');
console.log('bestbets tests passed.');
