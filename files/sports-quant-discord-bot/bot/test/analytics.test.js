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
const lu = A.buildLineup([mkAn('A'), mkAn('B'), mkAn('C'), mkAn('D')], {}, 3);
assert.ok(lu && lu.legs.length === 3);
close(lu.pInd, lu.legs.reduce((x, l) => x * l.p, 1), 1e-12); close(lu.pAdj, lu.pInd, 1e-12);
close(lu.dec, lu.legs.reduce((x, l) => x * l.dec, 1), 1e-12);
console.log('All analytics tests passed.');
