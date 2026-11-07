'use strict';
const assert = require('assert');
const os = require('os'), path = require('path'), fs = require('fs');
const file = path.join(os.tmpdir(), `picks-${process.pid}.json`);
try { fs.unlinkSync(file); } catch {}
process.env.TRACKER_FILE = file;
process.env.TRACK_TZ = 'America/Chicago';
const T = require('../services/tracker');

// ---- pure grading ----
const ml = (side) => ({ type: 'ML', side });
assert.strictEqual(T.gradeGame(ml('home'), 110, 100), 'win');
assert.strictEqual(T.gradeGame(ml('away'), 110, 100), 'loss');
assert.strictEqual(T.gradeGame({ type: 'SPREAD', side: 'home', line: -7.5 }, 110, 100), 'win');
assert.strictEqual(T.gradeGame({ type: 'SPREAD', side: 'home', line: -10 }, 110, 100), 'push');
assert.strictEqual(T.gradeGame({ type: 'SPREAD', side: 'away', line: 4.5 }, 110, 100), 'loss');
assert.strictEqual(T.gradeGame({ type: 'TOTAL', side: 'over', line: 209.5 }, 110, 100), 'win');
assert.strictEqual(T.gradeGame({ type: 'TOTAL', side: 'under', line: 210 }, 110, 100), 'push');
assert.strictEqual(T.gradeProp({ side: 'over', line: 24.5 }, 25), 'win');
assert.strictEqual(T.gradeProp({ side: 'under', line: 24.5 }, 25), 'loss');
assert.strictEqual(T.gradeProp({ side: 'over', line: 25 }, 25), 'push');

// ---- end to end with fake ESPN ----
const past = new Date(Date.now() - 8 * 36e5).toISOString();   // game started 8h ago
const common = { sport: 'nba', gameId: 'g1', home: 'Boston Celtics', away: 'Miami Heat', commenceTime: past, dec: 1.7, american: -143, book: 'X' };
const bets = [
  { ...common, type: 'ML', side: 'home', line: null, label: 'Boston Celtics ML', p: 0.70, pModel: 0.72, pMkt: 0.66 },
  { ...common, type: 'SPREAD', side: 'away', line: 4.5, label: 'Miami Heat +4.5', p: 0.62, pModel: 0.63, pMkt: 0.55 },
  { ...common, type: 'PROP', side: 'Over', line: 24.5, label: 'J Tatum Over 24.5 PTS', p: 0.64, estimated: true, player: 'J Tatum', playerId: '99', stat: 'points', team: 'Boston Celtics' },
  { ...common, type: 'TOTAL', side: 'over', line: 300.5, label: 'Over 300.5', p: 0.60, pModel: 0.6, pMkt: 0.55, gameId: 'g2', home: 'Nobody FC', away: 'Ghost City' },
];
assert.strictEqual(T.logPicks('nba', bets), 4);
assert.strictEqual(T.logPicks('nba', bets), 0, 're-running must not double count');

const fetchers = {
  scoreboard: async () => ({ events: [{ competitions: [{ status: { type: { completed: true } }, competitors: [
    { homeAway: 'home', score: '112', team: { displayName: 'Boston Celtics' } }, { homeAway: 'away', score: '104', team: { displayName: 'Miami Heat' } }] }] }] }),
  gameLog: async () => ({ labels: ['MIN', 'PTS', 'REB', 'AST'], events: { e1: { gameDate: past } },
    seasonTypes: [{ displayName: 'Regular Season', categories: [{ events: [{ eventId: 'e1', stats: ['34', '31', '8', '5'] }] }] }] }),
};
(async () => {
  const r = await T.gradePending({ fetchers, force: true });
  assert.strictEqual(r.graded, 3);
  const byLabel = Object.fromEntries(T._db().picks.map(p => [p.label, p.result]));
  assert.strictEqual(byLabel['Boston Celtics ML'], 'win');
  assert.strictEqual(byLabel['Miami Heat +4.5'], 'loss');        // lost by 8, +4.5 doesn't cover
  assert.strictEqual(byLabel['J Tatum Over 24.5 PTS'], 'win');
  assert.strictEqual(byLabel['Over 300.5'], 'pending', 'game not on the scoreboard stays pending');

  const s = T.summarize(T.selectPicks({ period: 'all' }));
  assert.strictEqual(s.w, 2); assert.strictEqual(s.l, 1); assert.strictEqual(s.pending, 1);
  assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-9);
  // units use only real-priced bets: ML win (+0.7) and spread loss (-1); the estimated prop is excluded
  assert.strictEqual(s.pricedN, 2); assert.ok(Math.abs(s.units - (0.7 - 1)) < 1e-9);
  assert.ok(s.avgPMkt > 0.5 && s.byType.ML.w === 1 && s.byType.SPREAD.l === 1);

  // a pick older than 36h that never became gradeable is voided, not left pending forever
  const r2 = await T.gradePending({ fetchers, force: true, now: Date.now() + 40 * 36e5 });
  assert.strictEqual(r2.voided, 1);
  assert.strictEqual(T.summarize(T.selectPicks({ period: 'all' })).pending, 0);
  assert.ok(T.dailyHistory(T.selectPicks({ period: 'all' })).length >= 1);
  assert.ok(T.daysReadyForRecap().length >= 1);

  // persistence: a fresh load of the file sees the same picks
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.picks.length, 4);
  fs.unlinkSync(file);
  console.log('tracker tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
