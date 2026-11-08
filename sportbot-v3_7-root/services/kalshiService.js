'use strict';
/**
 * kalshiService.js — Kalshi's FREE public market-data API (no key needed, read-only; the bot never trades).
 *   Base: https://api.elections.kalshi.com/trade-api/v2   (the "elections" host serves ALL Kalshi markets)
 *   Used endpoints: GET /series?category=Sports  ·  GET /markets?series_ticker=…&status=open
 *
 * What it adds: NBA player-prop prices from a second, independent market. A Kalshi "Giannis: 10+ rebounds"
 * contract becomes an Over 9.5 line with real Yes/No prices, in the same shape the Odds API props use, so the
 * existing prop logic (evaluateProp / buildProps / pickBestBets) treats it like any other real line.
 *
 * IMPORTANT: Kalshi's response field names and market titles are parsed DEFENSIVELY (several spellings accepted,
 * anything unparseable is skipped, never guessed). Run `npm run kalshi:probe` once on your machine to see what
 * was discovered and what was skipped, and tell me if a series is missing so the matcher can be tuned.
 */
const { guardedFetch, cached, TTL } = require('../cache/cacheManager');
const { normName, americanToDecimal, decimalToAmerican } = require('./analyticsEngine');

const BASE = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com/trade-api/v2';
const ENABLED = () => process.env.KALSHI_ENABLED !== '0';

const num = v => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const envNum = (k, d) => { const v = num(process.env[k]); return v === null ? d : v; };

const STAT_WORDS = { point: 'points', pts: 'points', rebound: 'rebounds', reb: 'rebounds', assist: 'assists', ast: 'assists' };
const statOf = text => {
  const m = /(points?|pts|rebounds?|reb|assists?|ast)\b/i.exec(text || '');
  return m ? STAT_WORDS[m[1].toLowerCase().replace(/s$/, '')] || STAT_WORDS[m[1].toLowerCase()] || null : null;
};

// Price helpers. Kalshi quotes contracts at 1-99 cents (a Yes at 40c pays $1 if it hits), newer payloads may use *_dollars strings.
function priceOf(m, key) {
  const d = num(m?.[`${key}_dollars`]);
  if (d !== null) return d;
  const c = num(m?.[key]);
  return c !== null ? c / 100 : null;
}

/** Approximate Kalshi taker fee per contract: rate * P * (1-P), rounded up to the cent (rate is tunable). */
function feeFor(price, rate = envNum('KALSHI_FEE_RATE', 0.07)) {
  return Math.ceil(rate * price * (1 - price) * 100 - 1e-9) / 100;
}

/** Buying a contract at `ask` pays $1 on a win: decimal odds = 1 / (ask + fee). */
function contractPrice(ask) {
  if (ask === null || !(ask >= 0.03 && ask <= 0.97)) return null;
  const dec = 1 / (ask + feeFor(ask));
  return { dec, american: decimalToAmerican(dec), book: 'Kalshi' };
}

/** Normalise one raw market into { ticker, yesBid, yesAsk, noBid, noAsk, … } or null when it has no usable two-sided quote. */
function normalizeMarket(m) {
  if (!m || !m.ticker) return null;
  let yesBid = priceOf(m, 'yes_bid'), yesAsk = priceOf(m, 'yes_ask'), noBid = priceOf(m, 'no_bid'), noAsk = priceOf(m, 'no_ask');
  if (yesAsk === null && noBid !== null) yesAsk = 1 - noBid;      // buying Yes is the mirror of someone bidding No
  if (noAsk === null && yesBid !== null) noAsk = 1 - yesBid;
  if (yesBid === null && noAsk !== null) yesBid = 1 - noAsk;
  if (yesAsk === null || noAsk === null || yesBid === null) return null;
  const closeMs = Date.parse(m.close_time || m.expected_expiration_time || m.expiration_time || '');
  return { ticker: m.ticker, eventTicker: m.event_ticker || null, title: m.title || '', subtitle: m.subtitle || '',
    yesSub: m.yes_sub_title || '', yesBid, yesAsk, noAsk, mid: (yesBid + yesAsk) / 2, spread: yesAsk - yesBid,
    volume: num(m.volume_fp ?? m.volume) ?? 0, closeMs: Number.isFinite(closeMs) ? closeMs : null,
    status: m.status || null };
}

/** "Giannis Antetokounmpo: 10+ rebounds" / "Will X record 10+ points?" / "X over 9.5 assists" -> { player, stat, line } */
function parsePropMarket(nm) {
  const texts = [nm.yesSub, nm.title, nm.subtitle].filter(Boolean);
  const all = texts.join(' | ');
  const stat = statOf(all);
  if (!stat) return null;

  let line = null;
  for (const t of texts) {
    let m;
    if ((m = /(\d+(?:\.\d+)?)\s*\+/.exec(t))) { line = Number(m[1]) - 0.5; break; }                    // "10+" = at least 10 = over 9.5
    if ((m = /(?:over|more than)\s+(\d+(?:\.\d+)?)/i.exec(t))) { line = Number(m[1]); break; }
    if ((m = /at least\s+(\d+(?:\.\d+)?)/i.exec(t))) { line = Number(m[1]) - 0.5; break; }
  }
  if (line === null || line <= 0) return null;
  if (!Number.isInteger(line * 2) || Number.isInteger(line)) return null;                                // only clean x.5 lines

  let player = null;
  for (const t of texts) {
    const m = /^(?:will\s+)?([A-Za-z][A-Za-z.'’\- ]{2,40}?)\s*(?::|\s+(?:over|record|score|have|get|grab|dish|make|total)\b)/i.exec(t.trim());
    if (m && !/^(?:yes|no|over|under)$/i.test(m[1].trim())) { player = m[1].trim(); break; }
  }
  if (!player) return null;
  return { player, stat, line };
}

async function kalshiGet(path) {
  return (await guardedFetch('kalshi', `${BASE}${path}`)).data;
}

/** Series that look like NBA player-prop ladders (points / rebounds / assists). */
function pickPropSeries(list, sport = 'nba') {
  if (sport !== 'nba') return [];
  return (Array.isArray(list) ? list : []).filter(s => {
    const t = `${s?.ticker || ''} ${s?.title || ''}`;
    return s?.ticker && /nba/i.test(t) && /(point|pts|rebound|reb\b|assist|ast\b)/i.test(t) && !/(parlay|multi|mve|combo)/i.test(t);
  }).map(s => s.ticker);
}

async function discoverSeries(sport) {
  const r = await cached(`kalshi:series:${sport}`, TTL.KALSHI_SERIES, async () => {
    const data = await kalshiGet('/series?category=Sports');
    return pickPropSeries(data?.series, sport);
  }, { optional: true });
  return r.value || [];
}

async function openMarkets(seriesTicker) {
  const r = await cached(`kalshi:markets:${seriesTicker}`, TTL.KALSHI_MARKETS, async () => {
    const out = [];
    let cursor = '';
    for (let page = 0; page < 3; page++) {
      const data = await kalshiGet(`/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const m of data?.markets || []) out.push(m);
      cursor = data?.cursor || '';
      if (!cursor) break;
    }
    return out;
  }, { optional: true });
  return r.value || [];
}

/**
 * Turn raw markets into the Odds-API-style prop map: { points|rebounds|assists: { [normName(player)]: { point, over, under, kalshi:true } } }.
 * Kalshi lists a ladder per player (4+, 6+, 8+ …): keep the rung closest to 50/50, which is the "main line".
 */
function buildPropMap(rawMarkets, { now = Date.now(), horizonMs = 48 * 3600e3, minVolume = envNum('KALSHI_MIN_VOLUME', 0), maxSpread = envNum('KALSHI_MAX_SPREAD', 0.08) } = {}) {
  const out = { points: {}, rebounds: {}, assists: {} };
  const stats = { parsed: 0, skippedParse: 0, skippedQuote: 0, sampleSkipped: [] };
  for (const raw of rawMarkets) {
    const nm = normalizeMarket(raw);
    if (!nm) { stats.skippedQuote++; continue; }
    if (nm.closeMs !== null && (nm.closeMs < now || nm.closeMs > now + horizonMs)) continue;   // only tonight's slate
    const pp = parsePropMarket(nm);
    if (!pp) { stats.skippedParse++; if (stats.sampleSkipped.length < 5) stats.sampleSkipped.push(nm.yesSub || nm.title); continue; }
    if (nm.spread > maxSpread || nm.volume < minVolume) { stats.skippedQuote++; continue; }    // thin/wide markets are not real prices
    const over = contractPrice(nm.yesAsk), under = contractPrice(nm.noAsk);
    if (!over || !under) { stats.skippedQuote++; continue; }
    stats.parsed++;
    const key = normName(pp.player), cur = out[pp.stat][key];
    const dist = Math.abs(nm.mid - 0.5);
    if (!cur || dist < cur._dist) out[pp.stat][key] = { point: pp.line, over, under, kalshi: true, ticker: nm.ticker, _dist: dist };
  }
  for (const m of Object.values(out)) for (const v of Object.values(m)) delete v._dist;
  return { props: out, stats };
}

/** Free NBA prop lines from Kalshi (cached 10 min). Never throws: returns { props: null } when unavailable. */
async function getKalshiProps(sport = 'nba') {
  if (!ENABLED() || sport !== 'nba') return { props: null };
  try {
    const series = (await discoverSeries(sport)).slice(0, envNum('KALSHI_MAX_SERIES', 6));
    if (!series.length) return { props: null, note: 'No Kalshi NBA prop series found.' };
    const raw = [];
    for (const t of series) raw.push(...await openMarkets(t));
    const { props, stats } = buildPropMap(raw);
    const n = Object.values(props).reduce((a, m) => a + Object.keys(m).length, 0);
    return { props: n ? props : null, stats, series, note: n ? null : 'Kalshi had no usable NBA prop quotes right now.' };
  } catch (e) {
    return { props: null, note: `Kalshi unavailable: ${e.message}` };
  }
}

/**
 * Combine Odds-API props (a) with Kalshi props (b). Same line -> best price per side across both.
 * Different lines -> keep the sportsbook line (b only fills players the books did not list).
 */
function mergeProps(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const out = { points: {}, rebounds: {}, assists: {} };
  for (const stat of Object.keys(out)) {
    const A = a[stat] || {}, B = b[stat] || {};
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const x = A[k], y = B[k];
      if (x && y && x.point === y.point) {
        const best = (p, q) => (!p ? q : !q ? p : q.dec > p.dec ? q : p);
        out[stat][k] = { ...x, over: best(x.over, y.over), under: best(x.under, y.under) };
      } else out[stat][k] = x || y;
    }
  }
  return out;
}

module.exports = { getKalshiProps, buildPropMap, normalizeMarket, parsePropMarket, pickPropSeries, contractPrice, feeFor, mergeProps, discoverSeries, openMarkets };
