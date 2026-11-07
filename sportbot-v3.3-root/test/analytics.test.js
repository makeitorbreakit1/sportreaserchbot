'use strict';
const assert = require('assert');
const A = require('../services/analyticsEngine');
const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

// odds math
close(A.americanToDecimal(-110), 1.9091); close(A.americanToDecimal(150), 2.5);
assert.strictEqual(A.decimalToAmerican(2.5), 150); assert.strictEqual(A.decimalToAmerican(1.9091), -110);
const [a, b] = A.noVig(-110, -110); close(a, 0.5); close(a + b, 1);
close(A.normCdf(0), 0.5); close(A.normCdf(1.96), 0.975, 1e-3);
close(A.expectedValue(0.55, 1.9091), 0.0500, 1e-3);

// rating shrinkage: same raw margin, fewer games -> smaller rating
const st = gp => ({ gp, winPct: 0.7, avgFor: 118, avgAgainst: 110, l10Pct: 0.8, streak: 2 });
assert.ok(A.teamRating('nba', st(10)).rating < A.teamRating('nba', st(60)).rating);

// injuries: star > depth, diminishing returns
const star = A.injuryPenalty('nba', [{ name: 'Star', status: 'Out', pos: 'G' }], { star: 28 });
const depth = A.injuryPenalty('nba', [{ name: 'Bench', status: 'Out', pos: 'G' }], {});
assert.ok(star.penalty > depth.penalty * 5);
const many = A.injuryPenalty('nba', Array.from({ length: 30 }, (_, i) => ({ name: 'P' + i, status: 'Out' })), {});
assert.ok(many.penalty < 10);

// full game model
const side = (p, avgFor, avgAgainst) => ({ gp: 20, winPct: p, avgFor, avgAgainst, l10Pct: p, streak: 0, name: 'x' });
const ctx = { standings: { byName: { 'boston celtics': side(0.75, 119, 109), 'miami heat': side(0.45, 110, 111) }, league: { avgFor: 114, avgAgainst: 114 } },
  injuries: { byTeam: { 'miami heat': [{ name: 'Big Guy', status: 'Out', pos: 'C' }] } },
  scoreboard: { byTeam: { 'boston celtics': { leaders: { ppg: { name: 'J Tatum', value: 27.1 }, rpg: { name: 'J Tatum', value: 8.4 } } }, 'miami heat': { leaders: {} } } } };
const price = (am) => ({ american: am, dec: A.americanToDecimal(am), book: 'T' });
const game = { id: 'g1', home: 'Boston Celtics', away: 'Miami Heat', commence: new Date().toISOString(),
  ml: { fairHome: 0.72, fairAway: 0.28, home: price(-260), away: price(220) },
  spread: { point: -7.5, fairHome: 0.5, fairAway: 0.5, home: price(-110), away: price(-110) } };
const an = A.analyzeGame('nba', game, ctx, 3);
assert.ok(an.reliable && an.projMargin > 0 && an.pHomeModel > 0.5 && an.pHomeModel < 1);
an.bets.forEach(x => { assert.ok(x.p > 0 && x.p < 1); close(x.ev, x.p * x.dec - 1, 1e-9); });
const props = A.buildProps(an, ctx, null); assert.ok(props.length >= 1 && props.every(p => p.p > 0 && p.p < 1));
console.log('sample projMargin', an.projMargin.toFixed(2), 'pHomeModel', an.pHomeModel.toFixed(3), 'blend', an.bets[0].p.toFixed(3));
console.log('sample prop', props[0].label, 'proj', props[0].proj.toFixed(1), 'p', props[0].p.toFixed(3));

// lineup: compound probability == product (no same-game legs), payout multiplies
const mk = (id, p, am, type = 'ML') => ({ type, gameId: id, team: id, side: 'home', label: id, p, american: am, dec: A.americanToDecimal(am), ev: p * A.americanToDecimal(am) - 1, book: 'T' });
const mkAn = id => ({ reliable: true, game: { id }, bets: [mk(id, 0.45, 130), mk(id + 'S', 0.5, -110, 'SPREAD')] });
const { strong } = A.buildDualParlays([mkAn('A'), mkAn('B'), mkAn('C'), mkAn('D')], {}, 3, 'game');
assert.ok(strong && strong.legs.length === 3);
close(strong.pInd, strong.legs.reduce((x, l) => x * l.p, 1), 1e-12); close(strong.pAdj, strong.pInd, 1e-12);
close(strong.dec, strong.legs.reduce((x, l) => x * l.dec, 1), 1e-12);

// regression: a team with NO standings must be "unknown" (not a silent rating of 0)
assert.strictEqual(A.teamRating('nba', null, {}, 'Nobody').known, false);
const noData = A.analyzeGame('nba', game, { standings: { byName: {}, league: null }, injuries: { byTeam: {} }, scoreboard: { byTeam: {} } }, 0);
assert.strictEqual(noData.reliable, false);

// ── v2 math ──
// power de-vig: sums to 1, shrinks the favorite's prob less than proportional scaling does at lopsided prices
const [pf, pd] = A.noVigPower(-1000, 600); close(pf + pd, 1, 1e-9);
assert.ok(pf > A.noVig(-1000, 600)[0] && pf < 1); // longshot vig is shaved harder
const [sym] = A.noVigPower(-110, -110); close(sym, 0.5, 1e-9);
// push handling: integer lines can push, half lines cannot; win+push+loss = 1
const nc = A.normalCover(3, -3, 12); assert.ok(nc.push > 0.02 && nc.push < 0.06); assert.strictEqual(A.normalCover(3, -3.5, 12).push, 0);
// Skellam margin dist: symmetric teams -> 50% each side; sums to 1; stronger home -> higher win prob
const d0 = A.marginDist(3, 3); let tot = 0; for (const v of d0.values()) tot += v; close(tot, 1, 1e-6);
const c0 = A.distCover(d0, 0); close(c0.win, (1 - c0.push) / 2, 1e-9);
assert.ok(A.distCover(A.marginDist(3.5, 2.5), 0).win > c0.win);
// Poisson totals: mean 6 -> over 5.5 more likely than over 6.5, win+push<=1
assert.ok(A.poissonOver(6, 5.5).win > A.poissonOver(6, 6.5).win);
const po = A.poissonOver(6, 6); assert.ok(po.push > 0.1 && po.win + po.push <= 1);
// NHL game end to end: finite probs, symmetric ML when teams equal and no home edge removed
const nhlSt = { gp: 30, winPct: 0.5, avgFor: 3.1, avgAgainst: 3.1, l10Pct: 0.5, streak: 0, name: 'x' };
const nhlCtx = { standings: { byName: { 'team a': nhlSt, 'team b': nhlSt }, league: { avgFor: 3.1, avgAgainst: 3.1 } }, injuries: { byTeam: {} }, scoreboard: { byTeam: {} } };
const mkp = am => ({ american: am, dec: A.americanToDecimal(am), book: 'T' });
const nhl = A.analyzeGame('nhl', { id: 'h', home: 'Team A', away: 'Team B', ml: { fairHome: 0.54, fairAway: 0.46, home: mkp(-118), away: mkp(100) },
  spread: { point: -1.5, fairHome: 0.4, fairAway: 0.6, home: mkp(160), away: mkp(-190) }, total: { point: 6.0, fairOver: 0.5, over: mkp(-105), under: mkp(-115) } }, nhlCtx, 0);
assert.ok(nhl.pHomeModel > 0.5 && nhl.pHomeModel < 0.6, `nhl pHome ${nhl.pHomeModel}`);
nhl.bets.forEach(b => assert.ok(Number.isFinite(b.ev) && b.p > 0 && b.p < 1, b.label));
console.log('All analytics tests passed.');
