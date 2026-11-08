'use strict';
/**
 * tracker.js: logs every /bestbets pick, grades it from final scores / player game logs, and reports the bot's
 * real win rate (overall, by day, by type, by sport, by confidence) so you can see whether its probabilities are honest.
 * Storage: a JSON file (TRACKER_FILE, default next to the usage counter). Put it on a Railway Volume to keep history.
 */
const fs = require('fs');
const path = require('path');
const { guardedFetch, ApiHardLimitError } = require('../cache/cacheManager');
const { nameMatchScore } = require('./analyticsEngine');
const { SPORTS, espnDate, parseGameLogRows } = require('./oddsService');

const ESPN_BASE = 'https://site.api.espn.com';
const ESPN_WEB = 'https://site.web.api.espn.com';
const H = 36e5;
const FILE = process.env.TRACKER_FILE ||
  path.join(path.dirname(process.env.COUNTER_FILE || path.join(__dirname, '..', 'data', 'usage.json')), 'picks.json');

// "Today" is the bot owner's calendar day, not UTC. Override with TRACK_TZ (any IANA zone).
const tz = () => process.env.TRACK_TZ || 'America/Chicago';
const dayKey = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz() });
// Hours after first pitch/tip before we try to grade
const GRADE_AFTER_H = { nba: 3.5, nfl: 4, nhl: 3.25, mlb: 4, epl: 3, mls: 3, uefa: 3, laliga: 3 };
const VOID_AFTER_H = 36;

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(s.picks)) {
      const cutoff = Date.now() - 400 * 24 * H;
      return { picks: s.picks.filter(p => (p.loggedAt || 0) > cutoff), recapped: s.recapped || {} };
    }
  } catch { /* first run */ }
  return { picks: [], recapped: {} };
}
let db = load();
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('[tracker] save failed:', e.message); }
}

/** Record picks shown to the user. Re-running /bestbets the same day never double-counts a pick. */
function logPicks(sport, bets, now = Date.now()) {
  const day = dayKey(now);
  let added = 0;
  for (const b of bets || []) {
    const side = String(b.side || '').toLowerCase();
    const mode = b.mode || 'history';
    const key = [day, mode, sport, b.gameId, b.type, side, b.line ?? '', b.player || '', b.stat || ''].join('|');
    if (db.picks.some(p => p.key === key)) continue;
    db.picks.push({
      key, mode, ver: process.env.MODEL_VERSION || '3.7', loggedAt: now, day, sport, type: b.type, gameId: b.gameId, home: b.home || null, away: b.away || null,
      commenceTime: b.commenceTime || null, side, team: b.team || null, line: b.line ?? null, label: b.label,
      p: b.p, pModel: b.pModel ?? null, pMkt: b.pMkt ?? null, dec: b.dec, american: b.american, book: b.book || null,
      estimated: !!b.estimated, player: b.player || null, playerId: b.playerId || null, stat: b.stat || null,
      result: 'pending', actual: null,
    });
    added++;
  }
  if (added) save();
  return added;
}

// ───────────────────────── Grading (pure) ─────────────────────────
function gradeGame(pick, hs, as) {
  const mine = pick.side === 'home' ? hs : as, opp = pick.side === 'home' ? as : hs;
  if (pick.type === 'ML') return mine > opp ? 'win' : mine < opp ? 'loss' : 'push';
  if (pick.type === 'SPREAD') { const v = mine - opp + pick.line; return v > 0 ? 'win' : v < 0 ? 'loss' : 'push'; }
  if (pick.type === 'TOTAL') {
    const t = hs + as;
    if (t === pick.line) return 'push';
    return (t > pick.line) === (pick.side === 'over') ? 'win' : 'loss';
  }
  return null;
}
function gradeProp(pick, actual) {
  if (actual === pick.line) return 'push';
  return (actual > pick.line) === (pick.side === 'over') ? 'win' : 'loss';
}

function parseFinals(data) {
  const out = [];
  for (const ev of data?.events || []) {
    const c = ev.competitions?.[0];
    const h = c?.competitors?.find(x => x.homeAway === 'home'), a = c?.competitors?.find(x => x.homeAway === 'away');
    if (!h || !a) continue;
    const hs = Number(h.score?.value ?? h.score), as = Number(a.score?.value ?? a.score);
    out.push({ done: !!(c.status?.type?.completed ?? ev.status?.type?.completed), home: h.team?.displayName || '', away: a.team?.displayName || '',
      hs, as, ok: Number.isFinite(hs) && Number.isFinite(as) });
  }
  return out;
}

const realFetchers = {
  scoreboard: async (sport, date) => (await guardedFetch('espn', `${ESPN_BASE}/apis/site/v2/sports/${SPORTS[sport].espn}/scoreboard?dates=${date}`)).data,
  gameLog: async (sport, id) => (await guardedFetch('espn', `${ESPN_WEB}/apis/common/v3/sports/${SPORTS[sport].espn}/athletes/${id}/gamelog`)).data,
};

let running = false, lastRun = 0;
const MIN_INTERVAL_MS = 10 * 60 * 1000;

/** Grades every pending pick whose game should be over. Free ESPN calls only (counted against the ESPN cap). */
async function gradePending({ fetchers = realFetchers, force = false, now = Date.now() } = {}) {
  if (running) return { skipped: true };
  if (!force && now - lastRun < MIN_INTERVAL_MS) return { skipped: true };
  running = true; lastRun = now;
  const res = { graded: 0, voided: 0, blocked: false };
  try {
    const due = db.picks.filter(p => p.result === 'pending' && p.commenceTime && now > Date.parse(p.commenceTime) + (GRADE_AFTER_H[p.sport] || 4) * H);

    const groups = new Map();
    for (const p of due.filter(x => x.type !== 'PROP')) {
      const k = `${p.sport}|${espnDate(p.commenceTime)}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(p);
    }
    for (const [k, list] of groups) {
      const [sport, date] = k.split('|');
      try {
        const finals = parseFinals(await fetchers.scoreboard(sport, date));
        for (const p of list) {
          const f = finals.find(x => x.done && x.ok && nameMatchScore(p.home, x.home) >= 60 && nameMatchScore(p.away, x.away) >= 60);
          if (!f) continue;
          p.result = gradeGame(p, f.hs, f.as); p.actual = `${f.away} ${f.as} - ${f.home} ${f.hs}`; p.gradedAt = now; res.graded++;
        }
      } catch (e) {
        if (e instanceof ApiHardLimitError) { res.blocked = true; break; }
        console.error('[tracker] scoreboard', k, e.message);
      }
    }

    const logs = new Map();
    for (const p of due.filter(x => x.type === 'PROP' && x.playerId && x.result === 'pending')) {
      const k = `${p.sport}|${p.playerId}`;
      (logs.get(k) || logs.set(k, []).get(k)).push(p);
    }
    if (!res.blocked) for (const [k, list] of logs) {
      const [sport, id] = k.split('|');
      try {
        const rows = parseGameLogRows(await fetchers.gameLog(sport, id));
        for (const p of list) {
          const row = rows.find(r => Math.abs(r.t - Date.parse(p.commenceTime)) < 12 * H);
          if (!row || row[p.stat] == null) continue;       // not posted yet (or DNP): retry later
          p.result = gradeProp(p, row[p.stat]); p.actual = `${row[p.stat]} ${p.stat}`; p.gradedAt = now; res.graded++;
        }
      } catch (e) {
        if (e instanceof ApiHardLimitError) { res.blocked = true; break; }
        console.error('[tracker] gamelog', k, e.message);
      }
    }

    // Postponed games, DNPs and picks we can never grade must not sit "pending" forever
    for (const p of db.picks) {
      if (p.result === 'pending' && p.commenceTime && now > Date.parse(p.commenceTime) + VOID_AFTER_H * H) { p.result = 'void'; p.gradedAt = now; res.voided++; }
    }
    if (res.graded || res.voided) save();
  } finally { running = false; }
  return res;
}

// ───────────────────────── Reporting ─────────────────────────
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const bucketOf = p => (p < 0.65 ? 'under 65%' : p < 0.75 ? '65-75%' : '75%+');
function tally(arr, keyFn) {
  const m = {};
  for (const p of arr) { const k = keyFn(p); const g = (m[k] ||= { w: 0, l: 0, sumP: 0 }); g[p.result === 'win' ? 'w' : 'l']++; g.sumP += p.p; }
  return m;
}

function summarize(picks) {
  const done = picks.filter(p => ['win', 'loss', 'push'].includes(p.result));
  const decided = done.filter(p => p.result !== 'push');
  const w = decided.filter(p => p.result === 'win').length;
  const priced = decided.filter(p => !p.estimated);
  const units = priced.reduce((s, p) => s + (p.result === 'win' ? p.dec - 1 : -1), 0);
  const mk = decided.filter(p => p.pMkt != null).map(p => p.pMkt);
  return {
    w, l: decided.length - w, push: done.length - decided.length, n: decided.length,
    pending: picks.filter(p => p.result === 'pending').length, voided: picks.filter(p => p.result === 'void').length,
    hitRate: decided.length ? w / decided.length : null, avgP: mean(decided.map(p => p.p)), avgPMkt: mean(mk),
    units, roi: priced.length ? units / priced.length : null, pricedN: priced.length,
    byMode: tally(decided, p => p.mode || 'history'), byType: tally(decided, p => p.type), bySport: tally(decided, p => (SPORTS[p.sport]?.label || p.sport)), byBucket: tally(decided, p => bucketOf(p.p)),
  };
}

function selectPicks({ period = 'today', sport = null, day = null, now = Date.now() } = {}) {
  let list = db.picks;
  if (period === 'today') list = list.filter(p => p.day === dayKey(now));
  else if (period === '7d') { const from = dayKey(now - 6 * 24 * H); list = list.filter(p => p.day >= from); }
  else if (period === 'day') list = list.filter(p => p.day === day);
  if (sport) list = list.filter(p => p.sport === sport);
  return list.slice().sort((a, b) => a.loggedAt - b.loggedAt);
}

function dailyHistory(picks, days = 7) {
  const m = new Map();
  for (const p of picks) { const g = m.get(p.day) || m.set(p.day, []).get(p.day); g.push(p); }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, days).map(([day, list]) => ({ day, ...summarize(list) }));
}

function daysReadyForRecap(now = Date.now()) {
  const today = dayKey(now), byDay = new Map();
  for (const p of db.picks) { const g = byDay.get(p.day) || byDay.set(p.day, []).get(p.day); g.push(p); }
  return [...byDay.entries()].filter(([d, l]) => d <= today && !db.recapped[d] && l.every(p => p.result !== 'pending')).map(([d]) => d).sort();
}
function markRecapped(day) { db.recapped[day] = true; save(); }

module.exports = { logPicks, gradePending, summarize, selectPicks, dailyHistory, daysReadyForRecap, markRecapped,
  gradeGame, gradeProp, parseFinals, dayKey, _db: () => db, _reset: () => { db = { picks: [], recapped: {} }; lastRun = 0; } };
