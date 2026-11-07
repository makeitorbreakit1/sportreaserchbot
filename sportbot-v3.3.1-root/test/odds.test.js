'use strict';
// End-to-end test of oddsService + engine with mocked network (no API credits used).
process.env.COUNTER_FILE = require('path').join(require('os').tmpdir(), `usage-${Date.now()}.json`);
process.env.ODDS_API_KEY = 'test'; process.env.MAX_DAILY_API_CALLS = '12'; process.env.COOLDOWN_SECONDS = '0';
const assert = require('assert');
const O = require('../services/oddsService');
const A = require('../services/analyticsEngine');
const C = require('../cache/cacheManager');

const iso = h => new Date(Date.now() + h * 3600e3).toISOString();
const bk = (title, hAm, aAm, pt, ov, un) => ({ title, markets: [
  { key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: hAm }, { name: 'Miami Heat', price: aAm }] },
  { key: 'spreads', outcomes: [{ name: 'Miami Heat', price: -110, point: -pt }, { name: 'Boston Celtics', price: -105, point: pt }].reverse() },
  { key: 'totals', outcomes: [{ name: 'Over', price: ov, point: 220.5 }, { name: 'Under', price: un, point: 220.5 }] }] });
const oddsBody = [{ id: 'e1', home_team: 'Boston Celtics', away_team: 'Miami Heat', commence_time: iso(5),
  bookmakers: [bk('A', -260, 220, -7.5, -110, -110), bk('B', -250, 230, -7.5, -105, -115)] },
  { id: 'e2', home_team: 'X', away_team: 'Y', commence_time: iso(200), bookmakers: [] }];
const entry = (n, w, l, pf, pa, l10) => ({ team: { displayName: n }, stats: [
  { name: 'wins', value: w }, { name: 'losses', value: l }, { name: 'winPercent', value: w / (w + l) },
  { name: 'avgPointsFor', value: pf }, { name: 'avgPointsAgainst', value: pa }, { name: 'streak', value: 2 },
  { name: 'record', displayName: 'Last Ten Games', displayValue: l10 }] });
const espn = {
  standings: { children: [{ standings: { entries: [entry('Boston Celtics', 15, 5, 119, 109, '8-2'), entry('Miami Heat', 9, 11, 110, 111, '4-6')] } }] },
  injuries: { injuries: [{ displayName: 'Miami Heat', injuries: [{ athlete: { displayName: 'Big Guy', position: { abbreviation: 'C' } }, status: 'Out' }] }] },
  scoreboard: { events: [{ competitions: [{ competitors: [{ team: { displayName: 'Boston Celtics' }, leaders: [{ name: 'pointsPerGame', leaders: [{ value: 27.1, athlete: { displayName: 'J Tatum' } }] }] }] }] }] },
};
let calls = [];
global.fetch = async (url) => {
  calls.push(url);
  const body = url.includes('the-odds-api') ? oddsBody : url.includes('/standings') ? espn.standings : url.includes('/injuries') ? espn.injuries : espn.scoreboard;
  return { ok: true, headers: new Map([['x-requests-used', '3']]), json: async () => body };
};

(async () => {
  const s = await O.getSlate('nba');
  assert.strictEqual(s.games.length, 1, 'window filter drops the game 200h away');
  const g = s.games[0];
  assert.strictEqual(g.home, 'Boston Celtics'); assert.strictEqual(g.away, 'Miami Heat');
  assert.strictEqual(g.spread.point, -7.5, 'spread point must be the HOME line even if away listed first');
  assert.strictEqual(g.ml.home.american, -250, 'best price across books');
  assert.ok(g.ml.fairHome > 0.6 && g.ml.fairHome < 0.8 && g.spread.fairHome > 0.4 && g.total.fairOver > 0.4);
  assert.ok(g.spread.home.dec > 1 && g.total.over.dec > 1);

  await O.getSlate('nba', { all: true });
  assert.strictEqual(calls.filter(u => u.includes('the-odds-api')).length, 1, 'second call must be served from cache');
  assert.strictEqual(C.usageSnapshot('odds').daily.used, 3, 'credits are counted (3 markets)');

  const ctx = await O.getAnalysisContext('nba');
  assert.deepStrictEqual(ctx.missing, []);
  const a = A.analyzeGame('nba', g, ctx, 0);
  assert.ok(a.reliable && a.projMargin > 5, `projMargin ${a.projMargin}`);
  assert.ok(a.home.rating.rating > 0 && a.away.injuries.penalty > 0, 'ratings + injuries now flow through');
  assert.strictEqual(a.bets.length, 6);
  a.bets.forEach(b => assert.ok(Number.isFinite(b.ev) && Number.isFinite(b.pMkt) && b.p > 0 && b.p < 1, `${b.label} has NaN`));
  const props = A.buildProps(a, ctx, null);
  assert.ok(props.length >= 1 && props.every(p => Number.isFinite(p.ev)));

  // hard cap: 12/day → 4th 3-credit call must throw BEFORE hitting the network
  const before = calls.length;
  for (const sp of ['nfl', 'nhl', 'mlb']) await O.getSlate(sp, { all: true });   // 3 more → 12/12
  await assert.rejects(() => O.getSlate('epl', { all: true }), e => e.name === 'ApiHardLimitError' || e.message.includes('Hard Limit') || e.name === 'ApiHardLimitError');
  console.log('All odds/e2e tests passed. network calls:', calls.length - before);
})().catch(e => { console.error(e); process.exit(1); });
