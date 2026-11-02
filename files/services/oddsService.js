'use strict';
/**
 * oddsService.js — multi-API data pullers. Every request goes through cached() + guardedFetch(), so:
 *   • repeated commands hit memory, not the network;
 *   • nothing leaves the process once a hard cap is reached.
 *
 * Credit plan (per sport, per cache window):
 *   Odds API   h2h+spreads+totals, 1 region ..... 3 credits / 60 min   (props: 3 credits, ON DEMAND only)
 *   ESPN       standings (12h) + injuries (3h) + scoreboard (2h) ... unmetered, own cap
 *   SportsDB   head-to-head, /analyze only, 24h ... 1 call per matchup
 *   Balldontlie team efficiency/stats ..... unmetered / custom integration
 */
const { guardedFetch, cached, syncProviderUsage, TTL } = require('../cache/cacheManager');
const { americanToDecimal, noVig, normName, findKey, nameMatchScore, MARKET_KEY } = require('./analyticsEngine');
const axios = require('axios');

const SPORTS = {
  nba: { label: 'NBA', oddsKey: 'basketball_nba', espn: 'basketball/nba', windowHours: 36, bdlId: 'nba' },
  nfl: { label: 'NFL', oddsKey: 'americanfootball_nfl', espn: 'football/nfl', windowHours: 144 },
  nhl: { label: 'NHL', oddsKey: 'icehockey_nhl', espn: 'hockey/nhl', windowHours: 36 },
  mlb: { label: 'MLB', oddsKey: 'baseball_mlb', espn: 'baseball/mlb', windowHours: 36 },
};
const SPORT_CHOICES = Object.entriesSPORTS = Object.entries(SPORTS).map(([value, c]) => ({ name: c.label, value }));

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports';
const SPORTSDB = 'https://www.thesportsdb.com/api/v1/json';
const BALLDONTLIE_BASE = 'https://api.balldontlie.io/v1';

// ───────────────────────── Odds API ─────────────────────────
const bestPrice = (rows, side) => {
  let best = null;
  for (const r of rows) {
    const dec = americanToDecimal(r[side]);
    if (!best || dec > best.dec) best = { american: r[side], dec, book: r.book };
  }
  return best;
};
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

function summarizeMoneyline(rows) {
  if (!rows.length) return null;
  const fair = rows.map(r => noVig(r.home, r.away)[0]);
  const fairHome = mean(fair);
  return { fairHome, fairAway: 1 - fairHome, home: bestPrice(rows, 'home'), away: bestPrice(rows, 'away'), nBooks: rows.length };
}

function summarizeSpread(rows) {
  if (!rows.length) return null;
  const counts = new Map();
  rows.forEach(r => counts.set(r.point, (counts.get(r.point) || 0) + 1));
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]));
  const point = sorted[0][0];                          // consensus (most common) home line
  const at = rows.filter(r => r.point === point);
  const fairHome = mean(at.map(r => noVig(r.home, r.away)[0]));
  return { point, fairHome, fairAway: 1 - fairHome, home: bestPrice(at, 'home'), away: bestPrice(at, 'away'), nBooks: at.length };
}

function summarizeTotal(rows) {
  if (!rows.length) return null;
  const counts = new Map();
  rows.forEach(r => counts.set(r.point, (counts.get(r.point) || 0) + 1));
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]));
  const point = sorted[0][0]; // consensus total line (e.g., 225.5)
  const at = rows.filter(r => r.point === point);
  return { point, over: bestPrice(at, 'over'), under: bestPrice(at, 'under'), nBooks: at.length };
}

function normalizeEvent(ev) {
  const h2h = [], spreads = [], totals = [];
  for (const bk of ev.bookmakers || []) {
    for (const m of bk.markets || []) {
      const h = m.outcomes?.find(o => o.name === ev.home_team);
      const a = m.outcomes?.find(o => o.name === ev.away_team);
      if (m.key === 'h2h' && h && a) {
        h2h.push({ book: bk.title, home: h.price, away: a.price });
      } else if (m.key === 'spreads' && h && a && h.point != null) {
        spreads.push({ book: bk.title, point: h.point, home: h.price, away: a.price });
      } else if (m.key === 'totals') {
        const overOutcome = m.outcomes?.find(o => o.name === 'Over');
        const underOutcome = m.outcomes?.find(o => o.name === 'Under');
        if (overOutcome && underOutcome && overOutcome.point != null) {
          totals.push({ book: bk.title, point: overOutcome.point, over: overOutcome.price, under: underOutcome.price });
        }
      }
    }
  }
  return { 
    id: ev.id, home: ev.home_team, away: ev.away_team, commence: ev.commence_time,
    ml: summarizeMoneyline(h2h), spread: summarizeSpread(spreads), total: summarizeTotal(totals) 
  };
}

/** Today's slate with consensus lines + best prices across ML, Spreads, and Totals. Cached 60 min. */
async function getSlate(sport) {
  const cfg = SPORTS[sport];
  const res = await cached(`odds:${sport}`, TTL.ODDS, async () => {
    if (!process.env.ODDS_API_KEY) throw new Error('ODDS_API_KEY is not set');
    // Added totals to markets parameter request string
    const url = `${ODDS_BASE}/sports/${cfg.oddsKey}/odds/?apiKey=${encodeURIComponent(process.env.ODDS_API_KEY)}`
      + '&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso';
    const { data, headers } = await guardedFetch('odds', url, { cost: 3 });
    syncProviderUsage('odds', Number(headers.get('x-requests-used')));
    return data.map(normalizeEvent).filter(g => g.ml || g.spread || g.total);
  });
  const now = Date.now(), horizon = now + cfg.windowHours * 3600e3;
  const games = res.value.filter(g => { const t = Date.parse(g.commence); return t > now && t < horizon; })
    .sort((a, b) => Date.parse(a.commence) - Date.parse(b.commence));
  return { games, stale: res.stale, blocked: res.blocked };
}

function findGame(games, a, b) {
  const ok = (q, n) => nameMatchScore(q, n) >= 50 || normName(n).split(' ').pop() === normName(q).split(' ').pop();
  return games.find(g => (ok(a, g.home) && ok(b, g.away)) || (ok(b, g.home) && ok(a, g.away))) || null;
}

// ───────────────────────── Balldontlie API Integration ─────────────────────────
/** Fetches advanced team metrics (season averages/pace indicators) using Railway env key */
async function getBalldontlieTeamStats(season, teamIds = []) {
  return cached(`bdl:stats:${season}:${teamIds.join(',')}`, TTL.STANDINGS, async () => {
    if (!process.env.BALLDONTLIE_API_KEY) return null;
    try {
      const response = await axios.get(`${BALLDONTLIE_BASE}/season_averages`, {
        headers: { 'Authorization': process.env.BALLDONTLIE_API_KEY },
        params: { season: season, team_ids: teamIds }
      });
      return response.data.data;
    } catch (error) {
      console.error('Balldontlie API fetch error:', error.message);
      return null;
    }
  }, { optional: true });
}

// ───────────────────────── ESPN (public, unofficial) ─────────────────────────
function collectEntries(node, out = []) {
  if (!node) return out;
  if (node.standings?.entries) out.push(...node.standings.entries);
  (node.children || []).forEach(c => collectEntries(c, out));
  return out;
}
function parseStandingsEntry(e) {
  const s = {};
  for (const st of e.stats || []) s[st.name] = st;
  const num = (...names) => { for (const n of names) { const v = s[n]?.value; if (Number.isFinite(v)) return v; } return null; };
  const wins = num('wins') ?? 0, losses = num('losses') ?? 0, ties = num('ties') ?? 0, otl = num('otLosses', 'overtimeLosses') ?? 0;
  const gp = num('gamesPlayed', 'gp') ?? wins + losses + ties + otl;
  if (!gp) return null;
  const pf = num('pointsFor', 'goalsFor', 'runsFor'), pa = num('pointsAgainst', 'goalsAgainst', 'runsAgainst');
  const avgFor = num('avgPointsFor', 'avgGoalsFor') ?? (pf != null ? pf / gp : null);
  const avgAgainst = num('avgPointsAgainst', 'avgGoalsAgainst') ?? (pa != null ? pa / gp : null);
  let l10Pct = null;
  for (const st of e.stats || []) {
    if (/last\s?ten|^l10$/i.test(`${st.name} ${st.type || ''}`) && st.displayValue) {
      const n = (st.displayValue.match(/\d+/g) || []).map(Number);
      const tot = n.reduce((a, b) => a + b, 0);
      if (tot >= 5) { l10Pct = n[0] / tot; break; }
    }
  }
  return { id: e.team?.id, name: e.team?.displayName, gp, winPct: (wins + 0.5 * ties) / gp, avgFor, avgAgainst, l10Pct,
           streak: num('streak') };
}
async function getStandings(sport) {
  return cached(`standings:${sport}`, TTL.STANDINGS, async () => {
    const { data } = await guardedFetch('espn', `${ESPN_V2}/${SPORTS[sport].espn}/standings`);
    const list = collectEntries(data).map(parseStandingsEntry).filter(t => t && t.name);
    const byName = {};
    list.forEach(t => { byName[normName(t.name)] = t; });
    const withScore = list.filter(t => t.avgFor != null && t.avgAgainst != null);
    const league = withScore.length ? { avgFor: mean(withScore.map(t => t.avgFor)), avgAgainst: mean(withScore.map(t => t.avgAgainst)) } : null;
    return { byName, league };
  }, { optional: true });
}
async function getInjuries(sport) {
  return cached(`injuries:${sport}`, TTL.INJURIES, async () => {
    const { data } = await guardedFetch('espn', `${ESPN_SITE}/${SPORTS[sport].espn}/injuries`);
    const byTeam = {};
    for (const t of data.injuries || []) {
      byTeam[normName(t.displayName)] = (t.injuries || []).map(i => ({
        name: i.athlete?.displayName || 'Unknown',
        pos: i.athlete?.position?.abbreviation || (typeof i.athlete?.position === 'string' ? i.athlete.position : '') || i.position?.abbreviation || '',
        status: i.status || i.type?.description || '',
      }));
    }
    return { byTeam };
  }, { optional: true });
}
async function getScoreboard(sport) {
  return cached(`scoreboard:${sport}`, TTL.SCOREBOARD, async () => {
    const { data } = await guardedFetch('espn', `${ESPN_SITE}/${SPORTS[sport].espn}/scoreboard`);
    const byTeam = {};
    for (const ev of data.events || []) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const weather = ev.weather ? { text: ev.weather.displayValue, temp: ev.weather.temperature } : null;
      const indoor = comp.venue?.indoor === true;
      for (const c of comp.competitors || []) {
        const leaders = {};
        for (const cat of c.leaders || []) {
          const n = String(cat.name || '').toLowerCase();
          const top = cat.leaders?.[0];
          if (!top?.athlete) continue;
          const value = parseFloat(top.displayValue ?? top.value);
          const key = n.includes('points') ? 'ppg' : n.includes('rebounds') ? 'rpg' : n.includes('assists') ? 'apg' : null;
          if (key && Number.isFinite(value) && value < 70) leaders[key] = { name: top.athlete.displayName, value };
        }
        byTeam[normName(c.team?.displayName)] = { leaders, weather: indoor ? null : weather };
      }
    }
    return { byTeam };
  }, { optional: true });
}

/** All ESPN context + Balldontlie stats for a sport in parallel. */
async function getAnalysisContext(sport) {
  const [st, inj, sb, bdl] = await Promise.all([
    getStandings(sport), 
    getInjuries(sport), 
    getScoreboard(sport),
    getBalldontlieTeamStats(2025) // Pulls current/recent season stats context
  ]);
  return {
    standings: st.value, injuries: inj.value, scoreboard: sb.value, balldontlie: bdl?.value,
    stale: st.stale || inj.stale || sb.stale, blocked: st.blocked || inj.blocked || sb.blocked,
    missing: [!st.value && 'standings', !inj.value && 'injuries'].filter(Boolean),
  };
}

module.exports = { SPORTS, SPORT_CHOICES, getSlate, findGame, getBalldontlieTeamStats, getAnalysisContext, findKey };
