'use strict';
// Renders every embed builder with realistic data so template-string / reference errors show up in `npm test`.
const assert = require('assert');
const E = require('../commands/embeds');

const pick = { type: 'ML', gameId: 'g', label: 'Boston Celtics ML', p: 0.7, pModel: 0.72, pMkt: 0.66, american: -150, dec: 1.67, book: 'X', ev: -0.01, kelly: 0.01,
  tier: { emoji: '🟢', label: 'HIGH', color: 0x2ecc71 }, why: 'Celtics at home: +6.1 avg margin (9 g) · H2H: 2-0 in 2 meeting(s)' };
const prop = { type: 'PROP', label: 'J Tatum Over 24.5 PTS (Boston Celtics) [8/10 L10]', p: 0.64, american: -110, dec: 1.91, book: 'est. -110', estimated: true,
  proj: 27.2, line: 24.5, avg: 26.1, l10Avg: 27.4, ev: 0.2, kelly: 0.01, tier: { emoji: '🟡', label: 'MEDIUM', color: 0xf1c40f } };

const e1 = E.bestBetsEmbed('NBA', [pick, prop], 8, {});
assert.ok(/\/record/.test(e1.d.description), 'best bets should point to /record');
assert.strictEqual(e1.d.fields.length, 2);
assert.ok(E.bestBetsEmbed('NBA', [], 8, {}).d.fields[0].name.includes('No high-confidence'));

const s = { w: 5, l: 2, push: 0, n: 7, pending: 3, voided: 0, hitRate: 5 / 7, avgP: 0.66, avgPMkt: 0.62, units: 1.2, roi: 0.17, pricedN: 7,
  byType: { ML: { w: 3, l: 1, sumP: 2.6 } }, bySport: { NBA: { w: 5, l: 2, sumP: 4.6 } }, byBucket: { '65-75%': { w: 5, l: 2, sumP: 4.6 } } };
const e2 = E.recordEmbed('Bot record: today', s, [{ ...pick, result: 'win', actual: 'MIA 104 - BOS 112' }], [{ day: '2026-11-07', ...s }]);
assert.ok(e2.d.description.includes('5-2'));
assert.ok(E.recordEmbed('x', { n: 0, pending: 0 }).d.description.includes('/bestbets'));
console.log('embeds tests passed.');
