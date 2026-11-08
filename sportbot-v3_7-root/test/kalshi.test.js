'use strict';
// Kalshi integration test with a MOCKED network. The payload shape below is my best understanding of Kalshi's
// public API (documented endpoints /series and /markets); `npm run kalshi:probe` shows the real shape.
process.env.COUNTER_FILE = require('path').join(require('os').tmpdir(), `usage-k-${Date.now()}.json`);
const assert = require('assert');
const K = require('../services/kalshiService');
const A = require('../services/analyticsEngine');
const C = require('../cache/cacheManager');

const close = new Date(Date.now() + 6 * 3600e3).toISOString();
const mk = (ticker, sub, yb, ya, nb, na, extra = {}) => ({ ticker, event_ticker: 'E1', title: sub, yes_sub_title: sub, yes_bid: yb, yes_ask: ya, no_bid: nb, no_ask: na, volume: 500, close_time: close, status: 'active', ...extra });
const markets = [
  mk('R4', 'Kel\'el Ware: 4+ rebounds', 90, 92, 8, 10),
  mk('R6', 'Kel\'el Ware: 6+ rebounds', 62, 64, 36, 38),          // closest to 50/50 -> main line (over 5.5)
  mk('R10', 'Kel\'el Ware: 10+ rebounds', 12, 14, 86, 88),
  mk('G11', 'Giannis Antetokounmpo: 11+ rebounds', 49, 51, 49, 51),
  mk('WIDE', 'Some Guy: 8+ points', 10, 60, 40, 90),                // 50-cent wide market: not a real price
  mk('JUNK', 'Who wins the game?', 50, 52, 48, 50),                 // not a prop
  mk('OLD', 'Past Guy: 5+ assists', 50, 52, 48, 50, { close_time: new Date(Date.now() - 3600e3).toISOString() }),
  { ticker: 'DOLLARS', event_ticker: 'E2', title: 'X', yes_sub_title: 'Dollar Guy: 20+ points', yes_bid_dollars: '0.4900', yes_ask_dollars: '0.5100', no_bid_dollars: '0.4900', no_ask_dollars: '0.5100', volume: 100, close_time: close },
];
const seriesBody = { series: [{ ticker: 'KXNBAREB', title: 'NBA player rebounds' }, { ticker: 'KXNBAGAME', title: 'NBA game winner' }, { ticker: 'KXNBAPARLAY', title: 'NBA points parlay' }, { ticker: 'KXNHLPTS', title: 'NHL player points' }] };

assert.deepStrictEqual(K.pickPropSeries(seriesBody.series), ['KXNBAREB'], 'only NBA prop series; no parlays, no game winners, no other sports');
const pp = K.parsePropMarket(K.normalizeMarket(markets[1]));
assert.deepStrictEqual(pp, { player: "Kel'el Ware", stat: 'rebounds', line: 5.5 }, '"6+" means at least 6 = over 5.5');
assert.strictEqual(K.parsePropMarket(K.normalizeMarket(markets[5])), null);
assert.ok(K.feeFor(0.5) >= 0.01 && K.feeFor(0.5) <= 0.03);
const cp = K.contractPrice(0.5); assert.ok(cp.dec < 2 && cp.dec > 1.8 && cp.book === 'Kalshi', 'a 50c ask pays a bit under even money after fees');
assert.strictEqual(K.contractPrice(0.99), null);

const { props, stats } = K.buildPropMap(markets);
assert.strictEqual(props.rebounds[A.normName("Kel'el Ware")].point, 5.5, 'ladder -> keeps the rung nearest 50/50');
assert.strictEqual(props.rebounds[A.normName('Giannis Antetokounmpo')].point, 10.5);
assert.ok(!props.points[A.normName('Some Guy')], 'a 50c-wide market is not a price');
assert.ok(!props.assists[A.normName('Past Guy')], 'expired market ignored');
assert.ok(props.points[A.normName('Dollar Guy')], '*_dollars fields accepted');
assert.ok(stats.skippedParse >= 1);

// merged with sportsbook props: same line -> best price per side; different line -> sportsbook wins
const pr = (am) => ({ american: am, dec: A.americanToDecimal(am), book: 'DK' });
const book = { points: {}, rebounds: { [A.normName('Giannis Antetokounmpo')]: { point: 10.5, over: pr(-105), under: pr(-125) }, [A.normName("Kel'el Ware")]: { point: 6.5, over: pr(-110), under: pr(-110) } }, assists: {} };
const merged = K.mergeProps(book, props);
const g = merged.rebounds[A.normName('Giannis Antetokounmpo')];
assert.ok(g.over.dec >= book.rebounds[A.normName('Giannis Antetokounmpo')].over.dec && g.under.dec >= A.americanToDecimal(-125));
assert.strictEqual(merged.rebounds[A.normName("Kel'el Ware")].point, 6.5, 'different line: keep the sportsbook number');
assert.strictEqual(K.mergeProps(null, null), null);

// end to end over a mocked network (free provider, counted against its own cap, cached)
let calls = [];
global.fetch = async (url) => {
  calls.push(url);
  const body = url.includes('/series') ? seriesBody : url.includes('/markets') ? { markets, cursor: '' } : {};
  return { ok: true, headers: new Map(), json: async () => body };
};
(async () => {
  const r = await K.getKalshiProps('nba');
  assert.ok(r.props && r.props.rebounds[A.normName("Kel'el Ware")], 'end to end props');
  assert.strictEqual(calls.length, 2, 'one /series call + one /markets call for the single matching series');
  await K.getKalshiProps('nba');
  assert.strictEqual(calls.length, 2, 'second call is served from cache');
  assert.strictEqual(C.usageSnapshot('kalshi').daily.used, 2);
  global.fetch = async () => { throw new Error('offline'); };
  process.env.KALSHI_ENABLED = '0';
  assert.strictEqual((await K.getKalshiProps('nba')).props, null, 'KALSHI_ENABLED=0 switches it off');
  process.env.KALSHI_ENABLED = '1';
  console.log('kalshi tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
