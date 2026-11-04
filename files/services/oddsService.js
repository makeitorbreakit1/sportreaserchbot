'use strict';
/**
 * oddsService.js — the ONLY place that talks to external data providers.
 *   • The Odds API  → lines (h2h / spreads / totals, player props)
 *   • ESPN public   → standings, injuries, scoreboard leaders
 * Every request goes through cacheManager.guardedFetch (hard quota caps) and cached() (TTL cache).
 */
const { guardedFetch, cached, TTL, syncProviderUsage } = require('../cache/cacheManager');
const { normName, americanToDecimal, noVigPower, MARKET_KEY } = require('./analyticsEngine');

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ESPN_BASE = 'https://site.api.espn.com';

// markets = what we request from the Odds API (1 credit per market per region).
// Soccer is 3-way on h2h, which the 2-way model can't use, so soccer only requests totals.
const SPORTS = {
  nba:    { label: 'NBA',                    key: 'basketball_nba',             espn: 'basketball/nba', windowHours: 36, markets: ['h2h', 'spreads', 'totals'], injuries: true,  board: true  },
  nfl:    { label: 'NFL',                    key: 'americanfootball_nfl',       espn: 'football/nfl',   windowHours: 72, markets: ['h2h', 'spreads', 'totals'], injuries: true,  board: true  },
  nhl:    { label: 'NHL',                    key: 'icehockey_nhl',              espn: 'hockey/nhl',     windowHours: 36, markets: ['h2h', 'spreads', 'totals'], injuries: true,  board: false },
  mlb:    { label: 'MLB',                    key: 'baseball_mlb',               espn: 'baseball/mlb',   windowHours: 36, markets: ['h2h', 'spreads', 'totals'], injuries: true,  board: true  },
  epl:    { label: 'Premier League',         key: 'soccer_epl',                 espn: 'soccer/eng.1',   windowHours: 72, markets: ['totals'], injuries: false, board: false },
  mls:    { label: 'MLS',                    key: 'soccer_usa_mls',             espn: 'soccer/usa.1',   windowHours: 72, markets: ['totals'], injuries: false, board: false },
  uefa:   { label: 'UEFA Champions League',  key: 'soccer_uefa_champs_league',  espn: 'soccer/uefa.champions', windowHours: 72, markets: ['totals'], injuries: false, board: false },
  laliga: { label: 'La Liga',                key: 'soccer_spain_la_liga',       espn: 'soccer/esp.1',   windowHours: 72, markets: ['totals'], injuries: false, board: false },
};
const SPORT_CHOICES = Object.entries(SPORTS).map(([value, c]) => ({ name: c.label, value }));

const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
const num = v => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const bestPrice = (cur, next) => (!cur || next.dec > cur.dec ? next : cur); // higher decimal = better for the bettor
const mkPrice = (o, book) => ({ american: o.price, dec: americanToDecimal(o.price), book: book.title || 'Book' });
const validPrice = o => o && Number.isFinite(o.price) && o.price !== 0;

// ───────────────────────── Odds API parsing ─────────────────────────
function parseGame(g) {
  if (!g || !g.home_team || !g.away_team) return null;   // never invent team names
  const home = g.home_team, away = g.away_team;
  const books = Array.isArray(g.bookmakers) ? g.bookmakers : [];
  const outcomesOf = (b, key) => b.markets?.find(m => m.key === key)?.outcomes;

  // Moneyline: best price per side across books, fair prob = average de-vigged prob
  let ml = null;
  {
    let bh = null, ba = null; const fairs = [];
    for (const b of books) {
      const oc = outcomesOf(b, 'h2h');
      if (!oc || oc.length !== 2) continue;
      const h = oc.find(o => o.name === home), a = oc.find(o => o.name === away);
      if (!validPrice(h) || !validPrice(a)) continue;
      bh = bestPrice(bh, mkPrice(h, b)); ba = bestPrice(ba, mkPrice(a, b));
      fairs.push(noVigPower(h.price, a.price)[0]);
    }
    if (bh && ba) { const fh = avg(fairs); ml = { home: bh, away: ba, fairHome: fh, fairAway: 1 - fh }; }
  }

  // Spread: `point` is the HOME team's line. Only compare books quoting the same line.
  let spread = null;
  {
    let ref = null, bh = null, ba = null; const fairs = [];
    for (const b of books) {
      const oc = outcomesOf(b, 'spreads');
      if (!oc) continue;
      const h = oc.find(o => o.name === home), a = oc.find(o => o.name === away);
      if (!validPrice(h) || !validPrice(a) || !Number.isFinite(h.point)) continue;
      if (ref === null) ref = h.point;
      if (h.point !== ref || a.point !== -ref) continue;
      bh = bestPrice(bh, mkPrice(h, b)); ba = bestPrice(ba, mkPrice(a, b));
      fairs.push(noVigPower(h.price, a.price)[0]);
    }
    if (bh && ba) { const fh = avg(fairs); spread = { point: ref, home: bh, away: ba, fairHome: fh, fairAway: 1 - fh }; }
  }

  // Totals
  let total = null;
  {
    let ref = null, bo = null, bu = null; const fairs = [];
    for (const b of books) {
      const oc = outcomesOf(b, 'totals');
      if (!oc) continue;
      const o = oc.find(x => x.name === 'Over'), u = oc.find(x => x.name === 'Under');
      if (!validPrice(o) || !validPrice(u) || !Number.isFinite(o.point)) continue;
      if (ref === null) ref = o.point;
      if (o.point !== ref || u.point !== ref) continue;
      bo = bestPrice(bo, mkPrice(o, b)); bu = bestPrice(bu, mkPrice(u, b));
      fairs.push(noVigPower(o.price, u.price)[0]);
    }
    if (bo && bu) total = { point: ref, over: bo, under: bu, fairOver: avg(fairs) };
  }

  return { id: g.id, home, away, commenceTime: g.commence_time, ml, spread, total };
}

function requireKey() {
  const k = process.env.ODDS_API_KEY;
  if (!k) throw new Error('ODDS_API_KEY is not set');
  return encodeURIComponent(k);
}

/** all=true returns every upcoming game; otherwise only games starting within the sport's window. */
async function getSlate(sport, { all = false } = {}) {
  const cfg = SPORTS[sport];
  if (!cfg) throw new Error(`Unknown sport "${sport}"`);
  const apiKey = requireKey();
  const r = await cached(`odds:${sport}`, TTL.ODDS, async () => {
    const url = `${ODDS_BASE}/sports/${cfg.key}/odds/?apiKey=${apiKey}&regions=us&markets=${cfg.markets.join(',')}&oddsFormat=american&dateFormat=iso`;
    const { data, headers } = await guardedFetch('odds', url, { cost: cfg.markets.length });
    syncProviderUsage('odds', Number(headers.get('x-requests-used')));
    if (!Array.isArray(data)) throw new Error('odds: unexpected response shape');
    return data.map(parseGame).filter(Boolean);
  });
  let games = r.value;
  if (!all) {
    const now = Date.now(), end = now + cfg.windowHours * 3600 * 1000;
    games = games.filter(g => { const t = Date.parse(g.commenceTime); return Number.isFinite(t) && t > now && t <= end; });
  }
  return { games, stale: r.stale, blocked: r.blocked, missing: [] };
}

// ───────────────────────── ESPN parsing (unofficial, defensive) ─────────────────────────
const espnGet = async path => (await guardedFetch('espn', `${ESPN_BASE}${path}`)).data;

function collectEntries(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node.standings?.entries)) out.push(...node.standings.entries);
  for (const c of node.children || []) collectEntries(c, out);
  return out;
}

function parseStandings(data) {
  const byName = {};
  for (const e of collectEntries(data)) {
    const name = e.team?.displayName || e.team?.name;
    if (!name) continue;
    const m = {}; let l10Pct = null;
    for (const s of e.stats || []) {
      const v = num(s.value ?? s.displayValue);
      for (const k of [s.name, s.type, s.abbreviation]) if (k && v !== null && !(k in m)) m[k] = v;
      const label = `${s.name || ''} ${s.displayName || ''} ${s.shortDisplayName || ''} ${s.abbreviation || ''}`;
      if (/last\s*ten|\bl10\b/i.test(label)) {
        const parts = String(s.displayValue || s.summary || '').match(/\d+/g)?.map(Number);
        if (parts && parts.length >= 2) { const tot = parts.reduce((a, b) => a + b, 0); if (tot > 0) l10Pct = parts[0] / tot; }
      }
    }
    const gp = m.gamesPlayed ?? ((m.wins || 0) + (m.losses || 0) + (m.ties || 0) + (m.otLosses || 0));
    if (!gp) continue;
    let avgFor = m.avgPointsFor ?? (m.pointsFor != null ? m.pointsFor / gp : null);
    let avgAgainst = m.avgPointsAgainst ?? (m.pointsAgainst != null ? m.pointsAgainst / gp : null);
    if (avgFor == null || avgAgainst == null) { avgFor = null; avgAgainst = null; }
    const winPct = m.winPercent ?? (m.wins != null ? m.wins / gp : 0.5);
    byName[normName(name)] = { name, gp, winPct, avgFor, avgAgainst, l10Pct, streak: m.streak ?? null };
  }
  const teams = Object.values(byName);
  if (!teams.length) throw new Error('standings: no entries parsed');
  const withPts = teams.filter(t => t.avgFor != null);
  const league = withPts.length ? { avgFor: avg(withPts.map(t => t.avgFor)), avgAgainst: avg(withPts.map(t => t.avgAgainst)) } : null;
  return { byName, league };
}

function parseInjuries(data) {
  const byTeam = {};
  for (const t of data?.injuries || []) {
    const name = t.displayName || t.team?.displayName;
    if (!name) continue;
    byTeam[normName(name)] = (t.injuries || [])
      .map(i => ({ name: i.athlete?.displayName || i.athlete?.fullName, pos: i.athlete?.position?.abbreviation || '', status: i.status || i.type?.description || '' }))
      .filter(i => i.name);
  }
  return { byTeam };
}

function parseScoreboard(data) {
  const byTeam = {};
  for (const ev of data?.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const w = ev.weather ? { text: ev.weather.displayValue || '', temp: num(ev.weather.temperature) } : null;
    for (const c of comp.competitors || []) {
      const name = c.team?.displayName;
      if (!name) continue;
      const leaders = {};
      for (const L of c.leaders || []) {
        const top = L.leaders?.[0];
        const v = top ? num(top.value ?? top.displayValue) : null;
        const who = top?.athlete?.displayName;
        if (v === null || !who) continue;
        const n = String(L.name || '');
        if (/^points/i.test(n)) leaders.ppg = { name: who, value: v };
        else if (/^rebounds/i.test(n)) leaders.rpg = { name: who, value: v };
        else if (/^assists/i.test(n)) leaders.apg = { name: who, value: v };
      }
      byTeam[normName(name)] = { leaders, weather: w };
    }
  }
  return { byTeam };
}

async function getAnalysisContext(sport) {
  const cfg = SPORTS[sport];
  const ctx = { standings: { byName: {}, league: null }, injuries: { byTeam: {} }, scoreboard: { byTeam: {} },
                stale: false, blocked: false, missing: [] };
  if (!cfg) return ctx;

  const jobs = [
    ['standings', cached(`standings:${sport}`, TTL.STANDINGS, async () => parseStandings(await espnGet(`/apis/v2/sports/${cfg.espn}/standings`)), { optional: true })],
  ];
  if (cfg.injuries) jobs.push(['injuries', cached(`injuries:${sport}`, TTL.INJURIES, async () => parseInjuries(await espnGet(`/apis/site/v2/sports/${cfg.espn}/injuries`)), { optional: true })]);
  if (cfg.board) jobs.push(['scoreboard', cached(`board:${sport}`, TTL.SCOREBOARD, async () => parseScoreboard(await espnGet(`/apis/site/v2/sports/${cfg.espn}/scoreboard`)), { optional: true })]);

  const results = await Promise.all(jobs.map(j => j[1]));
  jobs.forEach(([name], i) => {
    const r = results[i];
    ctx.stale = ctx.stale || r.stale;
    ctx.blocked = ctx.blocked || r.blocked;
    if (r.value) ctx[name] = r.value; else ctx.missing.push(name);
  });
  return ctx;
}

// H2H history is not wired to a provider; neutral (0) means "no adjustment".
async function getH2HMargin() { return { margin: 0 }; }

// ───────────────────────── NBA live player props (3 credits, cached 45 min) ─────────────────────────
function parseProps(data) {
  const statOf = Object.fromEntries(Object.entries(MARKET_KEY).map(([stat, key]) => [key, stat]));
  const out = { points: {}, rebounds: {}, assists: {} };
  for (const b of data?.bookmakers || []) {
    for (const m of b.markets || []) {
      const stat = statOf[m.key];
      if (!stat) continue;
      for (const o of m.outcomes || []) {
        if (!o.description || !Number.isFinite(o.point) || !validPrice(o)) continue;
        const pn = normName(o.description);
        const e = out[stat][pn] || (out[stat][pn] = { point: o.point });
        if (o.point !== e.point) continue;
        const side = o.name === 'Over' ? 'over' : o.name === 'Under' ? 'under' : null;
        if (side) e[side] = bestPrice(e[side], mkPrice(o, b));
      }
    }
  }
  return out;
}

async function getLiveProps(sport, game) {
  if (sport !== 'nba' || !game?.id) return { props: null };
  const apiKey = requireKey();
  const r = await cached(`props:${game.id}`, TTL.PROPS, async () => {
    const url = `${ODDS_BASE}/sports/${SPORTS.nba.key}/events/${encodeURIComponent(game.id)}/odds?apiKey=${apiKey}&regions=us&markets=${Object.values(MARKET_KEY).join(',')}&oddsFormat=american`;
    const { data, headers } = await guardedFetch('odds', url, { cost: 3 });
    syncProviderUsage('odds', Number(headers.get('x-requests-used')));
    return parseProps(data);
  });
  return { props: r.value, stale: r.stale, blocked: r.blocked };
}

module.exports = { SPORTS, SPORT_CHOICES, getSlate, getAnalysisContext, getH2HMargin, getLiveProps, parseGame, parseStandings, parseInjuries, parseScoreboard, parseProps };
