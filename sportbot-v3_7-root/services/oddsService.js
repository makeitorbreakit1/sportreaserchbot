'use strict';
/**
 * oddsService.js — the ONLY place that talks to external data providers.
 *   • The Odds API  → lines (h2h / spreads / totals, player props)
 *   • ESPN public   → standings, injuries, scoreboard leaders
 * Every request goes through cacheManager.guardedFetch (hard quota caps) and cached() (TTL cache).
 */
const { guardedFetch, cached, TTL, syncProviderUsage } = require('../cache/cacheManager');
const { normName, findKey, americanToDecimal, noVigPower, MARKET_KEY } = require('./analyticsEngine');

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ESPN_BASE = 'https://site.api.espn.com';
const ESPN_WEB = 'https://site.web.api.espn.com';

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
    byName[normName(name)] = { name, id: e.team?.id != null ? String(e.team.id) : null, gp, winPct, avgFor, avgAgainst, l10Pct, streak: m.streak ?? null };
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
        const id = top.athlete?.id != null ? String(top.athlete.id) : null;
        if (/^points/i.test(n)) leaders.ppg = { name: who, value: v, id };
        else if (/^rebounds/i.test(n)) leaders.rpg = { name: who, value: v, id };
        else if (/^assists/i.test(n)) leaders.apg = { name: who, value: v, id };
      }
      byTeam[normName(name)] = { leaders, weather: w };
    }
  }
  return { byTeam };
}

// ESPN date (YYYYMMDD, US Eastern) for a commence time: used to pull that day's scoreboard.
const espnDate = iso => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '') : null;
};

const scoreOf = c => { const sc = c?.score; if (sc == null) return null; return num(typeof sc === 'object' ? (sc.value ?? sc.displayValue) : sc); };

/** One team's season schedule: completed results (score, venue, rest inputs) plus upcoming games (venue). */
function parseSchedule(data, teamId) {
  const games = [];
  for (const ev of data?.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const me = (comp.competitors || []).find(c => String(c.team?.id) === String(teamId));
    const opp = (comp.competitors || []).find(c => c !== me);
    const t = Date.parse(ev.date || comp.date);
    if (!me || !opp || !Number.isFinite(t)) continue;
    const pf = scoreOf(me), pa = scoreOf(opp);
    const done = (comp.status?.type?.completed ?? ev.status?.type?.completed ?? false) && pf !== null && pa !== null;
    games.push({ t, home: me.homeAway === 'home', neutral: !!comp.neutralSite, opp: opp.team?.displayName || '',
      completed: !!done, pf: done ? pf : null, pa: done ? pa : null, margin: done ? pf - pa : null, win: done ? pf > pa : null,
      venue: comp.venue?.fullName || null, city: comp.venue?.address?.city || null });
  }
  if (!games.length) throw new Error('schedule: no games parsed');
  return { games: games.sort((x, y) => x.t - y.t) };
}

/** Player's last-10 stat lines (newest first). Returns null-safe arrays; throws if the shape is not what we expect. */
function parseGameLog(data) {
  const labels = data?.labels;
  if (!Array.isArray(labels)) throw new Error('gamelog: no labels');
  const ix = { points: labels.indexOf('PTS'), rebounds: labels.indexOf('REB'), assists: labels.indexOf('AST'), min: labels.indexOf('MIN') };
  if (ix.points < 0) throw new Error('gamelog: no PTS column');
  const rows = [];
  for (const st of data.seasonTypes || []) {
    if (/preseason/i.test(st.displayName || '')) continue;
    for (const cat of st.categories || []) for (const ev of cat.events || []) {
      const stats = ev.stats || [];
      const min = ix.min >= 0 ? num(stats[ix.min]) : 1;
      const t = Date.parse(data.events?.[ev.eventId]?.gameDate || '');
      if (!stats.length || !(min > 0) || !Number.isFinite(t)) continue;   // DNP or undated rows are skipped, never guessed
      rows.push({ t, points: num(stats[ix.points]), rebounds: ix.rebounds >= 0 ? num(stats[ix.rebounds]) : null, assists: ix.assists >= 0 ? num(stats[ix.assists]) : null });
    }
  }
  if (rows.length < 3) throw new Error('gamelog: too few dated games');
  const last = rows.sort((x, y) => y.t - x.t).slice(0, 10);
  const pick = k => last.map(r => r[k]).filter(v => v !== null);
  return { points: pick('points'), rebounds: pick('rebounds'), assists: pick('assists') };
}

/** Dated per-game rows (no limit, no throw): used to grade props after the game. */
function parseGameLogRows(data) {
  const labels = data?.labels;
  if (!Array.isArray(labels)) throw new Error('gamelog: no labels');
  const ix = { points: labels.indexOf('PTS'), rebounds: labels.indexOf('REB'), assists: labels.indexOf('AST'), min: labels.indexOf('MIN') };
  if (ix.points < 0) throw new Error('gamelog: no PTS column');
  const rows = [];
  for (const st of data.seasonTypes || []) {
    if (/preseason/i.test(st.displayName || '')) continue;
    for (const cat of st.categories || []) for (const ev of cat.events || []) {
      const stats = ev.stats || [];
      const min = ix.min >= 0 ? num(stats[ix.min]) : 1;
      const t = Date.parse(data.events?.[ev.eventId]?.gameDate || '');
      if (!stats.length || !(min > 0) || !Number.isFinite(t)) continue;
      rows.push({ t, points: num(stats[ix.points]), rebounds: ix.rebounds >= 0 ? num(stats[ix.rebounds]) : null, assists: ix.assists >= 0 ? num(stats[ix.assists]) : null });
    }
  }
  return rows;
}

function seasonYear(sport, ms) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (sport === 'nba' || sport === 'nhl') return m >= 8 ? y + 1 : y;
  if (sport === 'nfl') return m >= 3 ? y : y - 1;
  if (sport === 'mlb') return y;
  return m >= 7 ? y : y - 1;   // soccer leagues: ESPN labels a season by its starting year
}

/**
 * opts.games    – the games being analysed. Their teams get schedules (last 10, rest, venue) and their dates' scoreboards.
 * opts.withLogs – also fetch last-10 game logs for each team's statistical leaders (NBA props).
 */
async function getAnalysisContext(sport, opts = {}) {
  const cfg = SPORTS[sport];
  const ctx = { standings: { byName: {}, league: null }, injuries: { byTeam: {} }, scoreboard: { byTeam: {} },
                schedule: { byTeam: {} }, schedulePrev: { byTeam: {} }, gamelogs: {}, stale: false, blocked: false, missing: [] };
  if (!cfg) return ctx;
  const games = opts.games || [];
  const teams = [...new Set(games.flatMap(g => [g.home, g.away]))];
  const dates = [...new Set(games.map(g => espnDate(g.commenceTime)).filter(Boolean))].slice(0, 3);
  const note = r => { ctx.stale = ctx.stale || r.stale; ctx.blocked = ctx.blocked || r.blocked; return r; };
  const board = date => cached(`board:${sport}:${date || 'today'}`, TTL.SCOREBOARD,
    async () => parseScoreboard(await espnGet(`/apis/site/v2/sports/${cfg.espn}/scoreboard${date ? `?dates=${date}` : ''}`)), { optional: true });

  const jobs = [['standings', cached(`standings:${sport}`, TTL.STANDINGS, async () => parseStandings(await espnGet(`/apis/v2/sports/${cfg.espn}/standings`)), { optional: true })]];
  if (cfg.injuries) jobs.push(['injuries', cached(`injuries:${sport}`, TTL.INJURIES, async () => parseInjuries(await espnGet(`/apis/site/v2/sports/${cfg.espn}/injuries`)), { optional: true })]);
  if (cfg.board) jobs.push(['scoreboard', Promise.all((dates.length ? dates : [null]).map(board)).then(rs => {
    const merged = { byTeam: {} }; let any = false;
    rs.forEach(r => { if (r.value) { any = true; Object.assign(merged.byTeam, r.value.byTeam); } ctx.stale = ctx.stale || r.stale; ctx.blocked = ctx.blocked || r.blocked; });
    return { value: any ? merged : null, stale: false, blocked: false };
  })]);

  const results = await Promise.all(jobs.map(j => j[1]));
  jobs.forEach(([name], i) => { const r = note(results[i]); if (r.value) ctx[name] = r.value; else ctx.missing.push(name); });

  // Team schedules (need ESPN team ids, which come from standings)
  if (teams.length && ctx.standings.league !== undefined && Object.keys(ctx.standings.byName).length) {
    let failed = false;
    await Promise.all(teams.map(async name => {
      const key = findKey(name, Object.keys(ctx.standings.byName));
      const st = key ? ctx.standings.byName[key] : null;
      if (!st?.id) { failed = true; return; }
      const r = note(await cached(`sched:${sport}:${st.id}`, TTL.SCHEDULE,
        async () => parseSchedule(await espnGet(`/apis/site/v2/sports/${cfg.espn}/teams/${st.id}/schedule`), st.id), { optional: true }));
      if (r.value) ctx.schedule.byTeam[normName(name)] = r.value.games; else failed = true;
    }));
    if (failed) ctx.missing.push('schedule/last-10');
  }

  // Prior-season schedule (free ESPN call, cached 24h): gives head-to-head history beyond this season's 1-2 meetings
  if (teams.length && Object.keys(ctx.standings.byName).length) {
    const prevSeason = seasonYear(sport, Date.now()) - 1;
    await Promise.all(teams.map(async name => {
      const key = findKey(name, Object.keys(ctx.standings.byName));
      const st = key ? ctx.standings.byName[key] : null;
      if (!st?.id) return;
      const r = await cached(`schedprev:${sport}:${st.id}:${prevSeason}`, TTL.H2H,
        async () => parseSchedule(await espnGet(`/apis/site/v2/sports/${cfg.espn}/teams/${st.id}/schedule?season=${prevSeason}`), st.id), { optional: true });
      if (r.value) ctx.schedulePrev.byTeam[normName(name)] = r.value.games;
    }));
  }

  // Player last-10 game logs for the stat leaders of the analysed teams (NBA only)
  if (opts.withLogs && sport === 'nba' && teams.length) {
    const ids = new Map();
    for (const name of teams) {
      const k = findKey(name, Object.keys(ctx.scoreboard.byTeam));
      for (const l of Object.values(k ? ctx.scoreboard.byTeam[k].leaders : {})) if (l.id) ids.set(normName(l.name), l.id);
    }
    await Promise.all([...ids].map(async ([pn, id]) => {
      const r = note(await cached(`glog:${id}`, TTL.GAMELOG,
        async () => parseGameLog((await guardedFetch('espn', `${ESPN_WEB}/apis/common/v3/sports/${cfg.espn}/athletes/${id}/gamelog`)).data), { optional: true }));
      if (r.value) ctx.gamelogs[pn] = r.value;
    }));
    if (ids.size && !Object.keys(ctx.gamelogs).length) ctx.missing.push('player game logs');
  }
  return ctx;
}

// Legacy stub kept for compatibility: real head-to-head is now derived inside analyzeGame from ctx.schedule / ctx.schedulePrev.
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

module.exports = { SPORTS, SPORT_CHOICES, getSlate, getAnalysisContext, getH2HMargin, getLiveProps, espnDate, parseSchedule, parseGameLog, parseGameLogRows, parseGame, parseStandings, parseInjuries, parseScoreboard, parseProps };
