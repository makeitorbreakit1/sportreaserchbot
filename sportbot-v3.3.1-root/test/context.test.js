'use strict';
// Tests for schedule/last-10, rest & venue, injuries and player game-log logic. Mocked network, zero credits.
process.env.COUNTER_FILE = require('path').join(require('os').tmpdir(), `usage-ctx-${Date.now()}.json`);
process.env.ODDS_API_KEY = 'test';
const assert = require('assert');
const O = require('../services/oddsService');
const A = require('../services/analyticsEngine');

const H = 3600e3, gameMs = Date.now() + 5 * H, iso = ms => new Date(ms).toISOString();
// completed games, newest last. hoursAgo[i] = hours before tip-off; margins[i]; home flags
const sched = (id, rows) => ({ events: rows.map(([hAgo, margin, home, venue]) => {
  const me = { team: { id }, homeAway: home ? 'home' : 'away', score: { value: 100 + (margin > 0 ? margin : 0) } };
  const op = { team: { id: '99', displayName: 'Opp' }, homeAway: home ? 'away' : 'home', score: { value: 100 + (margin < 0 ? -margin : 0) } };
  return { date: iso(gameMs - hAgo * H), competitions: [{ competitors: [me, op], status: { type: { completed: true } }, venue: { fullName: venue || 'Arena', address: { city: 'X' } } }] };
}).concat([{ date: iso(gameMs), competitions: [{ competitors: [{ team: { id }, homeAway: 'home' }, { team: { id: '99' }, homeAway: 'away' }], status: { type: { completed: false } }, venue: { fullName: 'TD Garden', address: { city: 'Boston' } } }] }]) });

// Celtics (id 2): hot last 10, rested (last game 90h ago), 12 games at home/away mix
const bos = []; for (let i = 0; i < 12; i++) bos.push([90 + 48 * (11 - i), i < 2 ? 2 : 14, i % 2 === 0]);   // older 2 are small wins, recent 10 big wins
// Heat (id 14): cold last 10, played ~22h ago (back-to-back), on a road trip
const mia = []; for (let i = 0; i < 12; i++) mia.push([22 + 48 * (11 - i), i < 2 ? 6 : -8, i < 8 ? i % 2 === 0 : false]);

const entry = (id, n, w, l, pf, pa) => ({ team: { id, displayName: n }, stats: [{ name: 'wins', value: w }, { name: 'losses', value: l }, { name: 'winPercent', value: w / (w + l) }, { name: 'avgPointsFor', value: pf }, { name: 'avgPointsAgainst', value: pa }] });
const standings = { children: [{ standings: { entries: [entry('2', 'Boston Celtics', 12, 4, 118, 108), entry('14', 'Miami Heat', 8, 8, 110, 110), entry('99', 'Opp', 8, 8, 112, 112)] } }] };
const injuries = { injuries: [{ displayName: 'Miami Heat', injuries: [{ athlete: { displayName: 'Big Rebounder', position: { abbreviation: 'C' } }, status: 'Out' }, { athlete: { displayName: 'Bench Guy', position: { abbreviation: 'G' } }, status: 'Out' }] }] };
const L = (name, v, who, id) => ({ name, leaders: [{ value: v, athlete: { displayName: who, id } }] });
const board = { events: [{ competitions: [{ competitors: [
  { team: { displayName: 'Boston Celtics' }, leaders: [L('pointsPerGame', 27, 'J Tatum', '1'), L('reboundsPerGame', 8.4, 'J Tatum', '1'), L('assistsPerGame', 6.0, 'D White', '3')] },
  { team: { displayName: 'Miami Heat' }, leaders: [L('pointsPerGame', 22, 'T Hero', '4'), L('reboundsPerGame', 11, 'Big Rebounder', '5'), L('assistsPerGame', 5, 'T Hero', '4')] }] }] }] };
const labels = ['MIN', 'FG', 'FG%', '3PT', '3P%', 'FT', 'FT%', 'REB', 'AST', 'BLK', 'STL', 'PF', 'TO', 'PTS'];
const gl = (pts, reb, ast) => ({ labels, events: Object.fromEntries(pts.map((_, i) => [`g${i}`, { gameDate: iso(gameMs - (i + 1) * 48 * H) }])),
  seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ displayName: 'november', events: pts.map((p, i) => ({ eventId: `g${i}`, stats: ['34', '9-18', '50', '2-5', '40', '5-6', '83', String(reb[i]), String(ast[i]), '1', '1', '2', '2', String(p)] })).reverse() }] }] });
const tatum = gl([31, 30, 29, 33, 28, 26, 35, 30, 32, 29, 12, 10], Array(12).fill(8), Array(12).fill(4));   // newest-first order by date; 12 rows -> only last 10 used

global.fetch = async (url) => {
  let body;
  if (url.includes('/standings')) body = standings;
  else if (url.includes('/injuries')) body = injuries;
  else if (url.includes('/scoreboard')) body = board;
  else if (url.includes('/teams/2/schedule')) body = sched('2', bos);
  else if (url.includes('/teams/14/schedule')) body = sched('14', mia);
  else if (url.includes('/athletes/1/gamelog')) body = tatum;
  else return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
  return { ok: true, status: 200, headers: new Map(), json: async () => body };
};

(async () => {
  const game = { id: 'g', home: 'Boston Celtics', away: 'Miami Heat', commenceTime: iso(gameMs),
    ml: { fairHome: 0.72, fairAway: 0.28, home: { american: -260, dec: 1.385, book: 'T' }, away: { american: 220, dec: 3.2, book: 'T' } } };
  const full = await O.getAnalysisContext('nba', { games: [game], withLogs: true });
  assert.ok(full.schedule.byTeam['boston celtics'] && full.schedule.byTeam['miami heat'], 'schedules loaded');
  assert.ok(full.gamelogs['j tatum'], 'game log loaded for a leader');
  assert.deepStrictEqual(full.gamelogs['j tatum'].points.length, 10);
  assert.strictEqual(full.gamelogs['j tatum'].points[0], 31, 'newest game first');
  assert.ok(!full.missing.includes('schedule/last-10'));

  const a = A.analyzeGame('nba', game, full, 0);
  assert.ok(a.reliable);
  // Away team: back-to-back + road trip + cold L10 ; Home: rested + hot
  assert.strictEqual(a.away.sched.b2b, true, 'Heat are on a back-to-back');
  assert.ok(a.home.sched.daysSince > 3 && !a.home.sched.b2b);
  assert.ok(a.away.situation.adj < -1, `away situation ${a.away.situation.adj}`);
  assert.ok(a.home.situation.parts.rest > 0, 'rested home team gets the rest bonus');
  assert.ok(a.home.sched.l10.n === 10 && a.home.sched.l10.margin > a.home.sched.seasonMargin, 'home hot over last 10');
  assert.ok(a.away.sched.l10.margin < a.away.sched.seasonMargin, 'away cold over last 10');
  assert.ok(a.drivers.situation > 1.5, 'situation favors home');
  assert.strictEqual(a.venue.name, 'TD Garden');
  assert.ok(a.home.rating.formSource === 'last-10 margins');

  // Same game WITHOUT schedule data must project a smaller margin for Boston
  const noSched = await (async () => { const c = { ...full, schedule: { byTeam: {} } }; return A.analyzeGame('nba', game, c, 0); })();
  assert.ok(a.projMargin > noSched.projMargin + 1.5, `margin with context ${a.projMargin} vs without ${noSched.projMargin}`);

  // Injuries: a rebounding leader (11 rpg) is valued above a default bench player
  const items = a.away.injuries.items, big = items.find(i => i.name === 'Big Rebounder'), bench = items.find(i => i.name === 'Bench Guy');
  assert.ok(big.base >= 2.0 && big.impact > bench.impact * 3, `big ${big.base} bench ${bench.base}`);

  // Props use the real game log: L10 hit-rate text, L10 avg shown, projection pulled toward recent form
  const props = A.buildProps(a, full, null);
  const pts = props.find(p => p.player === 'J Tatum' && p.stat === 'points');
  assert.ok(pts && pts.l10Hits.endsWith('L10') && pts.l10Avg > 29, JSON.stringify(pts));
  assert.ok(pts.proj > 0 && Number.isFinite(pts.ev) && pts.p > 0 && pts.p < 1);

  // Unit: rest rules for other sports
  const g = (hAgo, m) => ({ t: gameMs - hAgo * H, home: true, completed: true, pf: 3 + m, pa: 3, margin: m, win: m > 0 });
  const nfl = A.summarizeSchedule('nfl', [g(24 * 4, 3), g(24 * 11, 1), g(24 * 18, -2), g(24 * 25, 7)], gameMs, true);
  assert.ok(A.situationAdjust('nfl', nfl, true).parts.rest < 0, 'short week penalised');
  assert.strictEqual(A.summarizeSchedule('nba', [g(10, 1)], gameMs, true), null, 'too few games -> no context, never invented');
  assert.strictEqual(A.altitudeBoost('nba', 'Denver Nuggets'), 1.0);
  assert.ok(A.weatherTotalAdj('nfl', { text: 'Heavy rain', temp: 30 }) <= -3);

  // Failure path: ESPN down for schedules -> flagged, analysis still runs with neutral context
  const realFetch = global.fetch;
  global.fetch = async (url) => (url.includes('/schedule') ? { ok: false, status: 500, headers: new Map(), json: async () => ({}) } : realFetch(url));
  const O2 = require('../services/oddsService');
  const bad = await O2.getAnalysisContext('nhl', { games: [{ ...game, home: 'Boston Celtics', away: 'Miami Heat', commenceTime: iso(gameMs + 60 * H) }] });
  assert.ok(bad.missing.includes('schedule/last-10'));
  assert.ok(A.analyzeGame('nhl', game, bad, 0).bets.every(b => Number.isFinite(b.ev)));
  console.log('All context tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
