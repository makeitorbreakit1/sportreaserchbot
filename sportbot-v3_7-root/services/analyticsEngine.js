'use strict';
/**
 * analyticsEngine.js — pure quantitative functions with empirical L10 hit-rate grading and true risk-separation.
 */

const SPORT_CFG = {
  nba: { homeAdv: 2.6, sd: 12.0, totalSd: 18.0, shrinkK: 15, winPctToMargin: 30, formScale: 8, formCap: 3.0, h2hWeight: 0.08, h2hCap: 2.0,
         injuryCap: 10, injuryDefault: 0.35, injuryPos: {} },
  nfl: { homeAdv: 1.8, sd: 13.2, totalSd: 13.0, shrinkK: 6, winPctToMargin: 28, formScale: 6, formCap: 3.0, h2hWeight: 0.06, h2hCap: 1.5,
         injuryCap: 10, injuryDefault: 0.25,
         injuryPos: { QB: 6.5, WR: 1.0, RB: 0.9, TE: 0.7, T: 0.9, OT: 0.9, G: 0.6, OG: 0.6, C: 0.6, OL: 0.7, DE: 0.9, DT: 0.8,
                      DL: 0.8, LB: 0.7, CB: 0.8, S: 0.6, DB: 0.6, K: 0.3, P: 0.1 } },
  nhl: { dist: 'poisson', defaultTotal: 6.0, homeAdv: 0.18, sd: 2.35, totalSd: 1.6, shrinkK: 20, winPctToMargin: 4, formScale: 1.0, formCap: 0.3, h2hWeight: 0.05, h2hCap: 0.15,
         injuryCap: 1.0, injuryDefault: 0.08, injuryPos: { G: 0.45, C: 0.15, W: 0.1, LW: 0.1, RW: 0.1, D: 0.09 } },
  mlb: { dist: 'poisson', defaultTotal: 8.8, homeAdv: 0.25, sd: 4.4, totalSd: 3.2, shrinkK: 45, winPctToMargin: 8, formScale: 1.2, formCap: 0.5, h2hWeight: 0.04, h2hCap: 0.2,
         injuryCap: 1.2, injuryDefault: 0.08, injuryPos: { SP: 0.5, P: 0.12, RP: 0.05, C: 0.12 } },
  epl: { dist: 'poisson', defaultTotal: 2.7, homeAdv: 0.35, sd: 1.2, totalSd: 1.3, shrinkK: 10, winPctToMargin: 6, formScale: 1.0, formCap: 0.4, h2hWeight: 0.04, h2hCap: 0.2,
         injuryCap: 1.0, injuryDefault: 0.05, injuryPos: {} },
  mls: { dist: 'poisson', defaultTotal: 2.9, homeAdv: 0.40, sd: 1.3, totalSd: 1.4, shrinkK: 10, winPctToMargin: 6, formScale: 1.0, formCap: 0.4, h2hWeight: 0.04, h2hCap: 0.2,
         injuryCap: 1.0, injuryDefault: 0.05, injuryPos: {} },
  uefa: { dist: 'poisson', defaultTotal: 2.8, homeAdv: 0.35, sd: 1.2, totalSd: 1.3, shrinkK: 10, winPctToMargin: 6, formScale: 1.0, formCap: 0.4, h2hWeight: 0.04, h2hCap: 0.2,
          injuryCap: 1.0, injuryDefault: 0.05, injuryPos: {} },
  laliga: { dist: 'poisson', defaultTotal: 2.6, homeAdv: 0.35, sd: 1.2, totalSd: 1.3, shrinkK: 10, winPctToMargin: 6, formScale: 1.0, formCap: 0.4, h2hWeight: 0.04, h2hCap: 0.2,
            injuryCap: 1.0, injuryDefault: 0.05, injuryPos: {} },
};

function envNum(k, d) { const raw = process.env[k]; const v = raw === undefined || raw === '' ? NaN : Number(raw); return Number.isFinite(v) ? v : d; }
const MIN_EV = 0.01;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const modelWeight = () => {
  const raw = process.env.MODEL_WEIGHT;
  const v = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0.35;
};

// Manual injury overrides. Keep EMPTY unless you update it every week: an entry applies to every game
// forever (the old Eagles QB-out entry silently shifted every Eagles line by 6.5 pts).
// Example: 'philadelphia eagles': { qbOut: true, penalty: 6.5 },
const MANUAL_OVERRIDES = {};

function normName(s = '') {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameMatchScore(query, candidate) {
  const q = normName(query), c = normName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.endsWith(' ' + q) || c.startsWith(q + ' ')) return 80;
  if (c.includes(q)) return 60;
  if (q.includes(c)) return 50;
  const qt = new Set(q.split(' '));
  return c.split(' ').filter(t => qt.has(t)).length * 20;
}
function findKey(query, names, minScore = 20) {
  let best = null, bs = 0;
  for (const n of names) { const s = nameMatchScore(query, n); if (s > bs) { bs = s; best = n; } }
  return bs >= minScore ? best : null;
}

const americanToDecimal = a => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const decimalToAmerican = d => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const americanToImplied = a => 1 / americanToDecimal(a);
const fmtAmerican = a => (a > 0 ? `+${a}` : `${a}`);
const fmtLine = n => (n > 0 ? `+${n}` : `${n}`);
function noVig(a1, a2) {
  const i1 = americanToImplied(a1), i2 = americanToImplied(a2), s = i1 + i2;
  return [i1 / s, i2 / s];
}
// Power-method de-vig: solves p1^k + p2^k = 1. Handles favorite/longshot bias better than simple proportional scaling.
function noVigPower(a1, a2) {
  const i1 = americanToImplied(a1), i2 = americanToImplied(a2);
  if (i1 + i2 <= 1) return [i1 / (i1 + i2), i2 / (i1 + i2)];
  let lo = 1, hi = 12;
  for (let n = 0; n < 60; n++) { const k = (lo + hi) / 2; if (i1 ** k + i2 ** k > 1) lo = k; else hi = k; }
  const k = (lo + hi) / 2, p1 = i1 ** k, p2 = i2 ** k;
  return [p1 / (p1 + p2), p2 / (p1 + p2)];
}
const expectedValue = (p, dec) => p * dec - 1;
// A push returns the stake, so EV = pWin*dec + pPush - 1 = (pWin + pPush/dec)*dec - 1.
const pushAdjusted = (win, push, dec) => win + (push > 0 ? push / dec : 0);
function kellyStake(p, dec, fraction = 0.25, cap = 0.02) {
  const b = dec - 1;
  return clamp(((b * p - (1 - p)) / b) * fraction, 0, cap);
}

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

// Normal margin model with integer-score continuity correction (whole-number lines can push).
function normalCover(M, point, sd) {
  if (Number.isInteger(point)) { const win = normCdf((M + point - 0.5) / sd); return { win, push: normCdf((M + point + 0.5) / sd) - win }; }
  return { win: normCdf((M + point) / sd), push: 0 };
}
function normalOver(proj, line, sd) {
  if (Number.isInteger(line)) { const w = 1 - normCdf((line + 0.5 - proj) / sd); return { win: w, push: normCdf((line + 0.5 - proj) / sd) - normCdf((line - 0.5 - proj) / sd) }; }
  return { win: 1 - normCdf((line - proj) / sd), push: 0 };
}
// Low-scoring sports (NHL, MLB, soccer): independent Poisson scores -> exact margin (Skellam) and total distributions.
const POIS_N = 45;
function poissonPmf(l, n = POIS_N) { const p = [Math.exp(-l)]; for (let k = 1; k < n; k++) p[k] = p[k - 1] * l / k; return p; }
function marginDist(lh, la) {
  const ph = poissonPmf(lh), pa = poissonPmf(la), d = new Map();
  for (let h = 0; h < POIS_N; h++) for (let a = 0; a < POIS_N; a++) { const pr = ph[h] * pa[a]; if (pr > 1e-12) d.set(h - a, (d.get(h - a) || 0) + pr); }
  return d;
}
function distCover(d, point) {
  let win = 0, push = 0;
  for (const [m, pr] of d) { const x = m + point; if (x > 1e-9) win += pr; else if (Math.abs(x) <= 1e-9) push += pr; }
  return { win, push };
}
function poissonOver(totalMean, line) {
  const pm = poissonPmf(totalMean, 80); let win = 0, push = 0;
  pm.forEach((pr, k) => { if (k > line + 1e-9) win += pr; else if (Math.abs(k - line) <= 1e-9) push += pr; });
  return { win, push };
}

function confidenceTier(ev, p) {
  if (ev >= 0.06 && p >= 0.5) return { key: 'HIGH', label: 'HIGH', emoji: '🟢', color: 0x2ecc71 };
  if (ev >= 0.03) return { key: 'MEDIUM', label: 'MEDIUM', emoji: '🟡', color: 0xf1c40f };
  if (ev >= MIN_EV) return { key: 'LOW', label: 'LOW', emoji: '🟠', color: 0xe67e22 };
  return { key: 'NONE', label: 'NO EDGE', emoji: '⚪', color: 0x95a5a6 };
}

function invNorm(p) { p = clamp(p, 0.001, 0.999); let lo = -6, hi = 6; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }

// The market's own margin for the game (home perspective): the sharpest single number available.
function marketMargin(cfg, game) {
  if (cfg.dist !== 'poisson' && game.spread?.point != null) return -game.spread.point;   // NBA/NFL spreads are balanced lines
  if (game.ml?.fairHome != null) return cfg.sd * invNorm(game.ml.fairHome);              // puck/run lines are not balanced: use the moneyline
  return null;
}

// Projected margin from the two teams' LAST 10 games: each side's expected points = avg(own L10 scored, opp L10 allowed).
function l10ProjMargin(cfg, home, away, altitude, h2hAdj) {
  const h = home.sched?.l10, a = away.sched?.l10;
  if (!h || !a || h.n < 5 || a.n < 5) return null;
  const hp = (h.pf + a.pa) / 2, ap = (a.pf + h.pa) / 2;
  return (hp - ap) + cfg.homeAdv + altitude + (away.injuries.penalty - home.injuries.penalty) + (home.situation.adj - away.situation.adj) + h2hAdj;
}

function teamRating(sport, st, apiSportsDef = null, teamName = '', shrinkScale = envNum('SHRINK_SCALE', 0.6)) {
  const cfg = SPORT_CFG[sport];
  if (!st) return { rating: 0, base: 0, form: 0, gp: 0, known: false };   // no standings => unknown, NOT "average"

  let raw = st && st.avgFor != null && st.avgAgainst != null 
    ? st.avgFor - st.avgAgainst 
    : st ? (st.winPct - 0.5) * cfg.winPctToMargin : 0;

  if (sport === 'nba' && apiSportsDef && teamName) {
    const normT = normName(teamName);
    const defAllowed = apiSportsDef[normT];
    if (defAllowed) {
      const defAdvantage = 112.0 - defAllowed;
      raw = (raw + defAdvantage) / 2;
    }
  }

  const shrink = st.gp / (st.gp + cfg.shrinkK * shrinkScale);
  let formDelta = 0;
  if (st.l10Pct != null) formDelta = st.l10Pct - st.winPct;
  else if (st.streak != null) formDelta = clamp(st.streak, -6, 6) * 0.03;
  const form = clamp(formDelta * cfg.formScale, -cfg.formCap, cfg.formCap) * shrink;
  return { rating: raw * shrink + form, base: raw * shrink, form, gp: st.gp, known: true };
}

const STATUS_WEIGHTS = [
  [/\bout\b|injured reserve|suspen|\bir\b/i, 1.0],
  [/doubtful/i, 0.85],
  [/questionable/i, 0.4],
  [/day/i, 0.3],
  [/probable/i, 0.1],
];
const statusWeight = (s = '') => { for (const [re, w] of STATUS_WEIGHTS) if (re.test(s)) return w; return 0.25; };

function injuryPenalty(sport, injuries = [], statsByName = {}) {
  const cfg = SPORT_CFG[sport];
  const items = [];
  for (const inj of injuries) {
    const w = statusWeight(inj.status);
    const pos = String(inj.pos || '').toUpperCase();
    let base = cfg.injuryPos[pos] ?? cfg.injuryDefault;
    const raw0 = statsByName[normName(inj.name)];
    const ps = typeof raw0 === 'number' ? { ppg: raw0 } : (raw0 || {});   // {ppg, rpg, apg} for the team's statistical leaders
    if (sport === 'nba') {
      if (ps.ppg >= 12) base = Math.max(base, ps.ppg * 0.17);
      if (ps.rpg >= 8) base = Math.max(base, ps.rpg * 0.20);
      if (ps.apg >= 6) base = Math.max(base, ps.apg * 0.30);
    }
    items.push({ name: inj.name, pos, status: inj.status, weight: w, base, impact: base * w });
  }
  items.sort((a, b) => b.impact - a.impact);
  const raw = items.reduce((s, i) => s + i.impact, 0);
  return { penalty: cfg.injuryCap * (1 - Math.exp(-raw / cfg.injuryCap)), raw, items };
}

// ───────────────────────── Schedule-derived context: last 10, rest, travel, venue ─────────────────────────
const H = 36e5; // ms per hour
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

function summarizeSchedule(sport, games, gameMs, isHome) {
  if (!Array.isArray(games)) return null;
  const done = games.filter(g => g.completed && g.t < gameMs).sort((x, y) => x.t - y.t);
  if (done.length < 3) return null;
  const n = done.length;
  const seasonMargin = mean(done.map(g => g.margin));
  const last = done.slice(-10).reverse();                         // newest first
  let wSum = 0, mSum = 0;
  last.forEach((g, i) => { const w = Math.pow(0.92, i); wSum += w; mSum += w * g.margin; });   // recency-weighted margin
  const l10 = { n: last.length, w: last.filter(g => g.win).length, l: last.filter(g => !g.win).length,
    margin: mSum / wSum, rawMargin: mean(last.map(g => g.margin)), pf: mean(last.map(g => g.pf)), pa: mean(last.map(g => g.pa)),
    total: mean(last.map(g => g.pf + g.pa)), seasonMargin, seasonTotal: mean(done.map(g => g.pf + g.pa)) };
  const hours = (gameMs - done[n - 1].t) / H;
  let road = 0, stand = 0;
  for (let i = n - 1; i >= 0 && !done[i].home && !done[i].neutral; i--) road++;
  for (let i = n - 1; i >= 0 && done[i].home; i--) stand++;
  const same = done.filter(g => g.home === isHome && !g.neutral);
  const up = games.find(g => !g.completed && Math.abs(g.t - gameMs) < 12 * H);
  return { n, seasonMargin, l10, daysSince: hours / 24, b2b: hours < 30,
    threeIn4: done.filter(g => (gameMs - g.t) / H <= 96).length >= 2,
    roadTrip: isHome ? 0 : road, homeStand: isHome ? stand : 0,
    venueSplit: { n: same.length, margin: same.length ? mean(same.map(g => g.margin)) : null },
    venue: up?.venue ? { name: up.venue, city: up.city } : null };
}

// Situational priors in each sport's own margin units. They are deliberately small: the market already prices
// most of this, and everything is further diluted by the model/market blend. Tune with a backtest.
function situationAdjust(sport, s, isHome) {
  const cfg = SPORT_CFG[sport], scale = cfg.sd / 12;
  const parts = { rest: 0, road: 0, venue: 0 }, notes = [];
  const d = s.daysSince;
  if (sport === 'nba') {
    if (s.b2b) { parts.rest -= 1.5; notes.push('Back-to-back (0 days rest)'); }
    else if (s.threeIn4) { parts.rest -= 0.6; notes.push('3rd game in 4 nights'); }
    else if (d >= 3.5) { parts.rest += 0.3; notes.push(`Well rested (${Math.round(d) - 1} days off)`); }
    else notes.push(`${Math.max(0, Math.round(d) - 1)} day(s) rest`);
  } else if (sport === 'nhl') {
    if (s.b2b) { parts.rest -= 0.10; notes.push('Back-to-back'); } else notes.push(`${Math.max(0, Math.round(d) - 1)} day(s) rest`);
  } else if (sport === 'nfl') {
    if (d <= 5.5) { parts.rest -= 0.8; notes.push(`Short week (${Math.round(d)} days)`); }
    else if (d >= 12.5) { parts.rest += 0.7; notes.push(`Extra rest / bye (${Math.round(d)} days)`); }
    else notes.push(`${Math.round(d)} days rest`);
  } else if (['epl', 'mls', 'uefa', 'laliga'].includes(sport)) {
    if (d <= 3.5) { parts.rest -= 0.08; notes.push(`Congested (${Math.round(d)} days since last match)`); } else notes.push(`${Math.round(d)} days since last match`);
  }
  if (s.roadTrip >= 3) { parts.road = -Math.min(1.0 * scale, 0.25 * scale * (s.roadTrip - 2)); notes.push(`Road trip game #${s.roadTrip + 1}`); }
  else if (s.homeStand >= 3) notes.push(`Homestand game #${s.homeStand + 1}`);
  const v = s.venueSplit;
  if (v.n >= 3 && v.margin != null) {
    // excess = how much better/worse this team does at this venue type than the generic home edge predicts
    const excess = (v.margin - s.seasonMargin) - (isHome ? 1 : -1) * cfg.homeAdv / 2;
    parts.venue = clamp(envNum('VENUE_WEIGHT', 1.0) * v.n / (v.n + 8) * excess, -2.5 * scale, 2.5 * scale);
    notes.push(`${isHome ? 'At home' : 'On the road'}: ${v.margin >= 0 ? '+' : ''}${v.margin.toFixed(1)} avg margin (${v.n} g)`);
  }
  return { adj: parts.rest + parts.road + parts.venue, parts, notes };
}

const ALTITUDE = { nba: { 'denver nuggets': 1.0, 'utah jazz': 0.4 }, nfl: { 'denver broncos': 0.8 } };
function altitudeBoost(sport, homeName) {
  const m = ALTITUDE[sport]; if (!m) return 0;
  const n = normName(homeName);
  for (const [k, v] of Object.entries(m)) if (n.includes(k)) return v;
  return 0;
}
function weatherTotalAdj(sport, wx) {
  if (!wx) return 0;
  const txt = String(wx.text || ''); let adj = 0;
  if (sport === 'nfl') { if (/rain|snow|shower|storm|thunder|sleet/i.test(txt)) adj -= 1.5; if (wx.temp != null && wx.temp <= 32) adj -= 1.5; }
  else if (sport === 'mlb') { if (/rain|storm|thunder|shower/i.test(txt)) adj -= 0.3; if (wx.temp != null && wx.temp >= 85) adj += 0.2; }
  return adj;
}

// Head-to-head from the schedules we already fetch. Each old meeting is stripped of its venue effect, then compared
// with what the ratings alone predict: only the RESIDUAL is applied (raw H2H margin would double-count team strength).
function h2hSummary(sport, game, ctx, gameMs) {
  const cfg = SPORT_CFG[sport];
  const cur = ctx.schedule?.byTeam?.[normName(game.home)] || [];
  const prev = ctx.schedulePrev?.byTeam?.[normName(game.home)] || [];
  let wSum = 0, mSum = 0, wins = 0, n = 0;
  for (const [games, w0] of [[cur, 1], [prev, 0.5]]) for (const g of games) {
    if (!g.completed || g.t >= gameMs || g.margin == null) continue;
    if (nameMatchScore(game.away, g.opp) < 60) continue;
    const neutral = g.neutral ? g.margin : g.margin + (g.home ? -cfg.homeAdv : cfg.homeAdv);   // home team's margin at a neutral site
    wSum += w0; mSum += w0 * neutral; n++; if (g.margin * (g.home ? 1 : -1) > 0) wins++;
  }
  return { n, wins, wSum, meanNeutral: wSum ? mSum / wSum : null };
}

function buildProfile(sport, teamName, ctx, gameMs = Date.now(), isHome = true, classic = false) {
  const stKey = findKey(teamName, Object.keys(ctx.standings?.byName || {}));
  const st = stKey ? ctx.standings.byName[stKey] : null;
  
  const apiSportsDef = ctx.apiSportsDefRatings || {};
  let rating = teamRating(sport, st, apiSportsDef, teamName, classic ? 1 : undefined);   // classic = original shrink constants

  // Last-10 form + situation from the team's actual schedule (replaces the coarse W-L / streak form proxy)
  const schKey = findKey(teamName, Object.keys(ctx.schedule?.byTeam || {}));
  const sched = schKey ? summarizeSchedule(sport, ctx.schedule.byTeam[schKey], gameMs, isHome) : null;
  if (!classic && rating.known && sched?.l10 && sched.l10.n >= 5) {
    const cfgF = SPORT_CFG[sport];
    const form = clamp(0.25 * (sched.l10.margin - sched.seasonMargin), -cfgF.formCap, cfgF.formCap) * (sched.l10.n / (sched.l10.n + 4));
    rating = { ...rating, form, rating: rating.base + form, formSource: 'last-10 margins' };
  }
  const sit0 = sched ? situationAdjust(sport, sched, isHome) : { adj: 0, parts: {}, notes: [] };
  const sit = classic ? { ...sit0, adj: 0 } : sit0;               // classic: no rest / road-trip / venue-split adjustments

  const injKey = findKey(teamName, Object.keys(ctx.injuries?.byTeam || {}));
  const sbKey = findKey(teamName, Object.keys(ctx.scoreboard?.byTeam || {}));
  const sb = sbKey ? ctx.scoreboard.byTeam[sbKey] : null;
  const leaders = sb?.leaders || {};
  const statsByName = {};
  for (const [k, l] of Object.entries(leaders)) if (l?.name) (statsByName[normName(l.name)] ||= {})[k] = l.value;
  const injuries = injuryPenalty(sport, injKey ? ctx.injuries.byTeam[injKey] : [], statsByName);

  let manualPenalty = 0;
  const normTeam = normName(teamName);
  for (const [key, val] of Object.entries(MANUAL_OVERRIDES)) {
    if (normTeam.includes(key) && val.qbOut) manualPenalty += val.penalty;
  }

  return { name: teamName, st, rating, injuries, leaders, sched, situation: sit, weather: sb?.weather || null,
           strength: rating.rating - (injuries.penalty + manualPenalty) + sit.adj };
}

function makeBet({ type, gameId, side, team, line, label, pModel, pMkt, price }) {
  const w = modelWeight();
  const p = w * pModel + (1 - w) * pMkt;
  const ev = expectedValue(p, price.dec);
  return { type, gameId, side, team, line, label, pModel, pMkt, p, american: price.american, dec: price.dec,
           book: price.book, ev, kelly: kellyStake(p, price.dec), tier: confidenceTier(ev, p) };
}

// opts.classic = the ORIGINAL bot's model: season margin + form, injuries, home edge; no rest/venue/H2H/last-10 blend, no market anchor.
function analyzeGame(sport, game, ctx, h2hMargin = null, opts = {}) {
  const classic = !!opts.classic;
  const cfg = SPORT_CFG[sport];
  const gameMs = Date.parse(game.commenceTime) || Date.now();
  const home = buildProfile(sport, game.home, ctx, gameMs, true, classic);
  const away = buildProfile(sport, game.away, ctx, gameMs, false, classic);
  const h2h = h2hSummary(sport, game, ctx, gameMs);
  let h2hAdj = 0;
  if (classic) h2hAdj = 0;
  else if (h2hMargin) h2hAdj = clamp(h2hMargin * cfg.h2hWeight, -cfg.h2hCap, cfg.h2hCap);          // explicit override (legacy)
  else if (h2h.n) {
    const resid = h2h.meanNeutral - (home.strength - away.strength);
    const scale = envNum('H2H_WEIGHT_SCALE', 4);
    h2hAdj = clamp(resid * (h2h.wSum / (h2h.wSum + 2)) * cfg.h2hWeight * scale, -cfg.h2hCap * 2, cfg.h2hCap * 2);
  }
  const altitude = altitudeBoost(sport, game.home);
  const ratingMargin = (home.strength + cfg.homeAdv + altitude + h2hAdj) - away.strength;
  const l10Margin = l10ProjMargin(cfg, home, away, altitude, h2hAdj);
  const L10W = classic ? 0 : envNum('L10_WEIGHT', 0.4);
  const histMargin = l10Margin == null ? ratingMargin : (1 - L10W) * ratingMargin + L10W * l10Margin;   // history only
  // Early-season ratings are noisy, so history can only pull the projection PART of the way from the market's number.
  // (Unanchored, every spread pick was "the model disagrees with the market", which is the weakest bet there is.)
  const mktMargin = marketMargin(cfg, game);
  const projMargin = mktMargin == null ? histMargin : mktMargin + (classic ? 1 : envNum('HIST_ANCHOR', 0.5)) * (histMargin - mktMargin);
  const hasTotStats = !!(home.st && away.st && home.st.avgFor != null && away.st.avgFor != null);
  let modelTotal = hasTotStats ? (home.st.avgFor + away.st.avgAgainst) / 2 + (away.st.avgFor + home.st.avgAgainst) / 2 : null;
  let totalNotes = [];
  let l10Total = null;
  if (home.sched?.l10 && away.sched?.l10) l10Total = (home.sched.l10.total + away.sched.l10.total) / 2;
  if (modelTotal != null && l10Total != null) {
    const wT = envNum('L10_TOTAL_WEIGHT', 0.5);
    totalNotes.push(`L10 combined scoring ${l10Total.toFixed(1)} vs season-based ${modelTotal.toFixed(1)}`);
    modelTotal = (1 - wT) * modelTotal + wT * l10Total;
  }
  const wxAdj = modelTotal != null ? weatherTotalAdj(sport, home.weather || away.weather) : 0;
  if (wxAdj) { modelTotal += wxAdj; totalNotes.push(`Weather ${wxAdj > 0 ? '+' : ''}${wxAdj.toFixed(1)}`); }

  // Low-scoring sports: anchor the scoring environment to the MARKET total (the sharpest number available),
  // then split it by the model's margin to get each side's expected score.
  const rawModelTotal = modelTotal;
  if (modelTotal != null && game.total?.point != null) modelTotal = game.total.point + envNum('TOTAL_ANCHOR', 0.5) * (modelTotal - game.total.point);
  const poisson = cfg.dist === 'poisson';
  const anchorT = game.total?.point ?? modelTotal ?? cfg.defaultTotal;
  const mdist = poisson ? marginDist(Math.max(0.05, (anchorT + projMargin) / 2), Math.max(0.05, (anchorT - projMargin) / 2)) : null;
  const cover = point => (mdist ? distCover(mdist, point) : normalCover(projMargin, point, cfg.sd));
  let pHomeModel;
  if (mdist) { let w = 0, t = 0; for (const [m, pr] of mdist) { if (m > 0) w += pr; else if (m === 0) t += pr; } pHomeModel = w / (1 - t || 1); }
  else pHomeModel = normCdf(projMargin / cfg.sd);
  const bets = [];

  if (game.ml) {
    bets.push(makeBet({ type: 'ML', gameId: game.id, side: 'home', team: game.home, line: null, label: `${game.home} ML`, pModel: pHomeModel, pMkt: game.ml.fairHome, price: game.ml.home }));
    bets.push(makeBet({ type: 'ML', gameId: game.id, side: 'away', team: game.away, line: null, label: `${game.away} ML`, pModel: 1 - pHomeModel, pMkt: game.ml.fairAway, price: game.ml.away }));
  }

  if (game.spread) {
    const s = game.spread, c = cover(s.point);
    const fairH = s.fairHome ?? noVigPower(s.home.american, s.away.american)[0];
    bets.push(makeBet({ type: 'SPREAD', gameId: game.id, side: 'home', team: game.home, line: s.point, label: `${game.home} ${fmtLine(s.point)}`, pModel: pushAdjusted(c.win, c.push, s.home.dec), pMkt: fairH, price: s.home }));
    bets.push(makeBet({ type: 'SPREAD', gameId: game.id, side: 'away', team: game.away, line: -s.point, label: `${game.away} ${fmtLine(-s.point)}`, pModel: pushAdjusted(1 - c.win - c.push, c.push, s.away.dec), pMkt: 1 - fairH, price: s.away }));
  }

  if (game.total && modelTotal != null && !classic) {
    const t = game.total;
    const o = poisson ? poissonOver(modelTotal, t.point) : normalOver(modelTotal, t.point, cfg.totalSd);
    const mktOverFair = t.fairOver ?? (t.over && t.under ? noVigPower(t.over.american, t.under.american)[0] : 0.5);
    const matchup = `${game.away} @ ${game.home}`;
    if (t.over) bets.push(makeBet({ type: 'TOTAL', gameId: game.id, side: 'over', team: 'Over', line: t.point, label: `Over ${t.point} (${matchup})`, pModel: pushAdjusted(o.win, o.push, t.over.dec), pMkt: mktOverFair, price: t.over }));
    if (t.under) bets.push(makeBet({ type: 'TOTAL', gameId: game.id, side: 'under', team: 'Under', line: t.point, label: `Under ${t.point} (${matchup})`, pModel: pushAdjusted(1 - o.win - o.push, o.push, t.under.dec), pMkt: 1 - mktOverFair, price: t.under }));
  }

  const reliable = home.rating.known && away.rating.known;
  const drivers = { ratings: home.rating.rating - away.rating.rating, injuries: away.injuries.penalty - home.injuries.penalty,
    situation: home.situation.adj - away.situation.adj, homeAdv: cfg.homeAdv + altitude, h2h: h2hAdj };
  return { sport, game, home, away, projMargin, histMargin, ratingMargin, l10Margin, mktMargin, l10Total, rawModelTotal, pHomeModel, h2hAdj, h2h, bets, reliable, drivers, modelTotal, totalNotes,
           venue: home.sched?.venue || null,
           pMktHome: game.ml?.fairHome ?? null, pHome: bets.find(b => b.type === 'ML' && b.side === 'home')?.p ?? pHomeModel };
}

const PROP_CV = { points: 0.30, rebounds: 0.40, assists: 0.45 };
const PROP_DEF_COEF = { points: 0.6, rebounds: 0.25, assists: 0.3 };
const PROP_USAGE_COEF = { points: 1, rebounds: 0.4, assists: 0.8 };
const STAT_ABBR = { points: 'PTS', rebounds: 'REB', assists: 'AST' };
const MARKET_KEY = { points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists' };

function projectPlayerStat({ stat, avg, team, opp, league, projMargin, teammateInjRaw = 0 }) {
  // (Old code blended every stat toward 35% of league TEAM scoring, which inflated rebounds/assists by ~50%.)
  const blendedAvg = avg;
  const expTotal = (team.st.avgFor + opp.st.avgAgainst) / 2 + (opp.st.avgFor + team.st.avgAgainst) / 2;
  const pace = clamp(expTotal / (2 * league.avgFor), 0.9, 1.1);
  const paceAdj = Math.pow(pace, 0.6);
  const defAdj = 1 + (opp.st.avgAgainst / league.avgAgainst - 1) * PROP_DEF_COEF[stat];
  const usage = 1 + clamp(teammateInjRaw * 0.02, 0, 0.10) * PROP_USAGE_COEF[stat];
  const blowout = 1 - clamp((Math.abs(projMargin) - 8) / 100, 0, 0.08);
  const proj = blendedAvg * paceAdj * defAdj * usage * blowout;
  return { proj, sd: Math.max(1.2, proj * PROP_CV[stat]), factors: { pace: paceAdj, def: defAdj, usage, blowout } };
}

// The highest alt line (x.5) this player should clear: model probability >= target AND the last 10 backs it (>= 8/10).
function safeLineFor({ proj, sd, scores = [], target = envNum('SAFE_LINE_P', 0.78) }) {
  const n = scores.length;
  let best = null;
  for (let L = Math.floor(proj * 0.4) + 0.5; L < proj; L += 1) {
    const pm = 1 - normCdf((L - proj) / sd);
    const hits = scores.filter(x => x > L).length;
    if (pm >= target && (n < 5 || hits / n >= 0.8)) best = { line: L, pModel: pm, hits, n };
  }
  return best;
}

function evaluateProp({ proj, sd, line, over, under, last10Scores = [] }) {
  const w = modelWeight();
  const pOverModel = 1 - normCdf((line - proj) / sd);
  // A prop is only "priced" when a real sportsbook posted BOTH sides. v3.4 invented a -110 price for every
  // line it made up, which turned "Giannis over 5.5 reb" into a fake +EV pick. No price => no EV, no bet.
  const priced = !!(over && under);
  const mktOver = priced ? noVigPower(over.american, under.american)[0] : null;

  const n = last10Scores.length;
  const hitsOver = last10Scores.filter(x => x > line).length;
  const hitsUnder = last10Scores.filter(x => x < line).length;
  let pOver;
  if (n >= 5) {
    // A raw 10-game hit rate is noisy, so smooth it toward the model, then anchor to the market price.
    const hit = (hitsOver + 4 * pOverModel) / (n + 4);
    pOver = priced ? 0.40 * pOverModel + 0.30 * hit + 0.30 * mktOver : 0.55 * pOverModel + 0.45 * hit;
  } else {
    pOver = priced ? w * pOverModel + (1 - w) * mktOver : pOverModel;
  }
  const pUnder = 1 - pOver;
  const evO = priced ? expectedValue(pOver, over.dec) : 0, evU = priced ? expectedValue(pUnder, under.dec) : 0;
  const pickOver = priced ? evO >= evU : pOver >= 0.5;
  const price = priced ? (pickOver ? over : under) : null;

  return {
    pOver, pUnder, pOverModel, mktOver, priced, overPrice: over || null, underPrice: under || null, l10N: n, hitsOver, hitsUnder,
    side: pickOver ? 'Over' : 'Under',
    p: pickOver ? pOver : pUnder,
    pModel: pickOver ? pOverModel : 1 - pOverModel,
    l10Hits: n ? `${pickOver ? hitsOver : hitsUnder}/${n} L10` : 'no L10 data',
    ev: priced ? (pickOver ? evO : evU) : 0,
    american: price ? price.american : null, dec: price ? price.dec : null, book: price ? price.book : 'no book line',
  };
}

function buildProps(analysis, ctx, live) {
  if (analysis.sport !== 'nba') return [];
  const league = ctx.standings?.league;
  if (!league) return [];
  const out = [];

  for (const [side, oppSide] of [['home', 'away'], ['away', 'home']]) {
    const team = analysis[side], opp = analysis[oppSide];
    if (!team.st || !opp.st || team.st.avgFor == null || opp.st.avgFor == null) continue;
    const injByName = new Map(team.injuries.items.map(i => [normName(i.name), i]));
    const seen = new Set();

    for (const [key, stat] of [['ppg', 'points'], ['rpg', 'rebounds'], ['apg', 'assists']]) {
      const l = team.leaders[key];
      if (!l || !(l.value > 0)) continue;

      const uid = `${normName(l.name)}:${stat}`;
      if (seen.has(uid)) continue; seen.add(uid);
      const own = injByName.get(normName(l.name));
      if (own && own.weight >= 0.85) continue;

      const teammateRaw = Math.max(0, team.injuries.raw - (own ? own.impact : 0));
      // Blend season average with the player's real last-10 average when we have the game log
      const log = ctx.gamelogs?.[normName(l.name)]?.[stat] || [];
      const l10Avg = log.length >= 5 ? mean(log) : null;
      const baseAvg = l10Avg != null ? 0.35 * l.value + 0.65 * l10Avg : l.value;   // last 10 games drive the projection
      const pr = projectPlayerStat({ stat, avg: baseAvg, team, opp, league, projMargin: side === 'home' ? analysis.projMargin : -analysis.projMargin, teammateInjRaw: teammateRaw });

      const liveLine = live?.[stat]?.[normName(l.name)];
      const last10 = log.length ? log : (liveLine?.last10Scores || []);
      // No live sportsbook line => projection only. The "line" is just the number a book would likely post
      // (the half-point nearest the projection) so the hit rate is meaningful; it is NEVER bet on or priced.
      const line = liveLine ? liveLine.point : Math.floor(pr.proj) + 0.5;
      const lineGapSd = Math.abs(line - pr.proj) / pr.sd;
      // A real line far from our projection almost always means bad inputs (wrong player/stat, stale average), not an edge.
      const suspect = !!liveLine && lineGapSd > envNum('PROP_MAX_GAP_SD', 1.1);

      const ev = evaluateProp({ proj: pr.proj, sd: pr.sd, line, over: liveLine?.over, under: liveLine?.under, last10Scores: last10 });

      out.push({
        type: 'PROP',
        gameId: analysis.game.id,
        home: analysis.game.home, away: analysis.game.away, commenceTime: analysis.game.commenceTime,
        playerId: l.id || null,
        team: team.name,
        player: l.name,
        stat,
        line,
        estimated: !liveLine,
        safeLine: null,
        lineGapSd,
        suspect,
        avg: l.value,
        l10Avg,
        proj: pr.proj,
        sd: pr.sd,
        factors: pr.factors,
        questionable: !!own,
        ...ev,
        label: `${l.name} ${ev.side} ${line} ${STAT_ABBR[stat]} (${team.name})${liveLine ? '' : ' (no book line)'} [${ev.l10Hits}]`,
        kelly: ev.priced ? kellyStake(ev.p, ev.dec) : 0,
        tier: confidenceTier(ev.ev, ev.p)
      });
    }
  }
  return out.sort((a, b) => (a.estimated - b.estimated) || (b.ev - a.ev));
}

// ───────────────────────── Best bets: ranked by PROBABILITY OF HITTING ─────────────────────────
// v3 ranked by EV (+0.3*(p-0.5)), which surfaces thin-edge coin flips (p 50-55%). These picks target hit rate:
//   * game bets need model AND market to both favour the side, with blended p >= BEST_MIN_P
//   * props need a real projection edge AND the last-10 games must back the same side
// EV is only a floor (never pay heavy juice), not the ranking key. NOTE: a high hit rate is not the same as
// profit: a -300 favourite must win 75% just to break even.
// v3.6: "realistic" picks. The old rules ranked by raw hit probability, which rewards the most obvious
// bets (heavy favourites, a star over a tiny number) and allowed negative EV. Now every pick needs a real
// price, a positive EV against that price, and a model-vs-market gap small enough to be believable.
const BEST_MIN_P = () => envNum('BEST_MIN_P', 0.52);
const BEST_MIN_EV = () => envNum('BEST_MIN_EV', 0.015);
const BEST_MIN_DEC = () => envNum('BEST_MIN_DEC', 1.5);       // no favourite shorter than -200
const BEST_MAX_DEC = () => envNum('BEST_MAX_DEC', 3.0);       // no longshot longer than +200
const BEST_MAX_GAP = () => envNum('BEST_MAX_GAP', 0.15);      // |model - market| above this usually means bad data
const PROP_MIN_P = () => envNum('BEST_MIN_PROP_P', 0.54);
const PROP_MAX_P = () => envNum('BEST_MAX_PROP_P', 0.72);     // props are noisy: a "78%" prop at -110 is a data error
const PROP_MIN_EV = () => envNum('BEST_MIN_PROP_EV', 0.03);
const PROP_MIN_DEC = () => envNum('BEST_MIN_PROP_DEC', 1.6);  // no prop juiced past about -165
const BEST_MIN_L10 = () => envNum('BEST_MIN_L10_RATE', 0.6);
const bestScore = b => b.ev + 0.3 * (b.p - 0.5);

// Pick the side of a prop. With real prices: the side with the better EV. Without: the likelier side (projection only).
function propLean(pr) {
  const priced = !!(pr.overPrice && pr.underPrice);
  const over = priced
    ? expectedValue(pr.pOver, pr.overPrice.dec) >= expectedValue(pr.pUnder, pr.underPrice.dec)
    : pr.pOver >= pr.pUnder;
  const price = priced ? (over ? pr.overPrice : pr.underPrice) : null;
  const p = over ? pr.pOver : pr.pUnder;
  const hits = over ? pr.hitsOver : pr.hitsUnder;
  const side = over ? 'Over' : 'Under';
  const mktFair = pr.mktOver == null ? null : (over ? pr.mktOver : 1 - pr.mktOver);
  return { ...pr, side, p, priced, mktFair, dec: price ? price.dec : null, american: price ? price.american : null, book: price ? price.book : 'no book line',
    ev: price ? expectedValue(p, price.dec) : 0, kelly: price ? kellyStake(p, price.dec) : 0,
    l10Rate: pr.l10N ? hits / pr.l10N : null,
    label: `${pr.player} ${side} ${pr.line} ${STAT_ABBR[pr.stat]} (${pr.team})${pr.estimated ? ' (no book line)' : ''} [${pr.l10N ? `${hits}/${pr.l10N} L10` : 'no L10'}]` };
}

function whyLines(a, b) { try { return whyLinesRaw(a, b); } catch { return ''; } }
function whyLinesRaw(a, b) {
  if (!a || b.type === 'TOTAL') return a?.totalNotes?.slice(0, 2).join(' · ') || '';
  const mine = b.side === 'home' ? a.home : a.away, opp = b.side === 'home' ? a.away : a.home;
  const out = [];
  const venue = mine.situation.notes.find(n => /^At home|^On the road/.test(n));
  if (venue) out.push(`${mine.name} ${venue.charAt(0).toLowerCase()}${venue.slice(1)}`);
  const l10m = mine.sched?.l10?.rawMargin, l10o = opp.sched?.l10?.rawMargin;
  if (l10m != null && l10o != null) out.push(`L10 margin ${l10m >= 0 ? '+' : ''}${l10m.toFixed(1)} vs ${l10o >= 0 ? '+' : ''}${l10o.toFixed(1)}`);
  if (a.h2h?.n) out.push(`H2H: ${b.side === 'home' ? a.h2h.wins : a.h2h.n - a.h2h.wins}-${b.side === 'home' ? a.h2h.n - a.h2h.wins : a.h2h.wins} in ${a.h2h.n} meeting(s)`);
  const names = t => t.injuries.items.filter(i => i.weight >= 0.4).slice(0, 2).map(i => i.name).join(', ');
  if (opp.injuries.penalty >= 0.3 && names(opp)) out.push(`${opp.name} missing ${names(opp)}`);
  if (mine.injuries.penalty >= 0.3 && names(mine)) out.push(`${mine.name} also missing ${names(mine)}`);
  return out.join(' · ');
}

// History must agree, independently of the market: ratings AND last-10 points both have to back the side.
function bestGuard(a, b) {
  if (a.histMargin === undefined) return true;                       // minimal/legacy analysis objects
  const scale = SPORT_CFG[a.sport].sd / 12;
  const s = b.side === 'home' || b.side === 'over' ? 1 : -1;
  if (b.type === 'ML') return s * a.histMargin > 0 && (a.l10Margin == null || s * a.l10Margin > 0);
  if (b.type === 'SPREAD') {
    const pt = a.game.spread?.point;
    if (pt == null || a.l10Margin == null) return false;             // can't verify with last-10 data: no spread pick
    const cushion = envNum('SPREAD_CUSHION', 1.0) * scale;
    if (s * (a.l10Margin + pt) < cushion || s * (a.histMargin + pt) < cushion) return false;
    const mine = b.side === 'home' ? a.home : a.away, l10 = mine.sched?.l10?.rawMargin;
    if (b.line >= 6.5 * scale && l10 != null && l10 < -0.6 * b.line) return false;   // big underdog that has been losing by more than that
    return true;
  }
  if (b.type === 'TOTAL') {
    if (a.l10Total == null || a.rawModelTotal == null) return false;
    const cushion = envNum('TOTAL_CUSHION', 1.5) * scale, o = b.side === 'over' ? 1 : -1;
    return o * (a.l10Total - b.line) >= cushion && o * (a.rawModelTotal - b.line) >= cushion;
  }
  return true;
}

// The ORIGINAL selection rule, kept so the two approaches can be compared on real results (/record shows both).
// Probability is 35% model / 65% market (MODEL_WEIGHT), so picks stay close to what the sharpest number says.
function pickBestBetsClassic(analyses, limit = 5) {
  const score = b => b.ev + 0.3 * (b.p - 0.5);
  const pool = analyses.filter(a => a.reliable).flatMap(a => a.bets)
    .filter(b => b.type !== 'TOTAL' && Math.abs(b.pModel - b.pMkt) <= 0.20 && b.ev >= MIN_EV && b.p >= 0.5 && b.dec <= 2.3)
    .sort((x, y) => score(y) - score(x));
  const seen = new Set(), out = [];
  for (const b of pool) {
    if (seen.has(b.gameId)) continue; seen.add(b.gameId);
    const a = analyses.find(x => x.game.id === b.gameId);
    out.push({ ...b, home: a?.game?.home, away: a?.game?.away, commenceTime: a?.game?.commenceTime, why: whyLines(a, b) });
    if (out.length >= limit) break;
  }
  return out;
}

function pickBestBets(analyses, limit = 5, props = []) {
  const minP = BEST_MIN_P(), minEv = BEST_MIN_EV(), minDec = BEST_MIN_DEC(), maxDec = BEST_MAX_DEC(), maxGap = BEST_MAX_GAP();
  // The model (ratings, last-10, splits, H2H, injuries) is already anchored to the market line in analyzeGame;
  // here it is blended with the de-vigged market so one noisy input cannot create a huge "edge".
  const w = clamp(envNum('BEST_MODEL_WEIGHT', 0.6), 0, 1);
  const games = [];
  for (const a of analyses.filter(x => x.reliable)) for (const b0 of a.bets) {
    if (!bestGuard(a, b0)) continue;
    if (b0.dec < minDec || b0.dec > maxDec) continue;              // real prices only: no -400 locks, no +500 lottery tickets
    if (b0.pModel < 0.5 || b0.pMkt < 0.40) continue;               // model must favour the side; market may not be strongly against
    if (Math.abs(b0.pModel - b0.pMkt) > maxGap) continue;          // guard: a huge gap usually means missing data
    const p = w * b0.pModel + (1 - w) * b0.pMkt;
    const ev = expectedValue(p, b0.dec);
    if (p < minP || ev < minEv) continue;                          // must beat the posted price, not just win often
    games.push({ ...b0, p, ev, kelly: kellyStake(p, b0.dec), why: whyLines(a, b0), home: a.game?.home, away: a.game?.away, commenceTime: a.game?.commenceTime, tier: confidenceTier(ev, p) });
  }
  games.sort((x, y) => bestScore(y) - bestScore(x));
  const seenGame = new Set(), gamePicks = [];
  for (const b of games) { if (seenGame.has(b.gameId)) continue; seenGame.add(b.gameId); gamePicks.push(b); }

  // Props: ONLY real sportsbook lines with both sides priced. Projection-only rows are never picks.
  const propPicks = [], seenPlayer = new Set();
  props.filter(pr => !pr.questionable && !pr.estimated && !pr.suspect).map(propLean)
    .filter(x => x.priced && x.dec >= PROP_MIN_DEC() && x.dec <= maxDec
      && x.p >= PROP_MIN_P() && x.p <= PROP_MAX_P() && x.ev >= PROP_MIN_EV()
      && x.l10N >= 5 && x.l10Rate >= BEST_MIN_L10()
      && x.mktFair != null && Math.abs(x.p - x.mktFair) <= 0.2)
    .sort((a, b) => bestScore(b) - bestScore(a))
    .forEach(x => { if (!seenPlayer.has(x.player)) { seenPlayer.add(x.player); propPicks.push({ ...x, tier: confidenceTier(x.ev, x.p) }); } });

  return [...gamePicks, ...propPicks].sort((a, b) => bestScore(b) - bestScore(a)).slice(0, limit);
}

// Suggested way to bet the list: singles are the core; at most one 2-leg parlay from different games.
// Joint probability multiplies, so every extra leg costs a lot (3 legs at 70% = 34%, 4 legs = 24%).
function buildSlip(picks, { straightMinP = envNum('SLIP_STRAIGHT_P', 0.55), parlayMinP = envNum('SLIP_PARLAY_MIN_P', 0.45) } = {}) {
  const straights = picks.filter(b => b.p >= straightMinP).slice(0, 3);
  let best = null;
  for (let i = 0; i < picks.length; i++) for (let j = i + 1; j < picks.length; j++) {
    const a = picks[i], b = picks[j];
    if (a.gameId === b.gameId) continue;                              // same-game legs are correlated: skip
    const joint = a.p * b.p, priced = !a.estimated && !b.estimated;
    if (!best || joint > best.p) best = { legs: [a, b], p: joint, dec: priced ? a.dec * b.dec : null };
  }
  const parlay = best && best.p >= parlayMinP ? { ...best, ev: best.dec ? best.p * best.dec - 1 : null } : null;
  return { straights, parlay };
}

function legCorrelation(a, b) {
  if (a.gameId !== b.gameId) return { ok: true, rho: 0 };
  const [t, pr] = a.type === 'PROP' ? [b, a] : [a, b];
  if (t.type === 'PROP' || pr.type !== 'PROP') return { ok: false };
  return pr.side === 'Over' && pr.team === t.team ? { ok: true, rho: 0.2 } : { ok: false };
}

function evalCombo(legs) {
  const pairs = [];
  for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
    const c = legCorrelation(legs[i], legs[j]);
    if (!c.ok) return null;
    if (c.rho) pairs.push([i, j, c.rho]);
  }
  const used = new Set();
  let pAdj = 1;
  for (const [i, j, rho] of pairs) {
    if (used.has(i) || used.has(j)) return null;
    used.add(i); used.add(j);
    const pa = legs[i].p, pb = legs[j].p;
    pAdj *= Math.min(pa * pb + rho * Math.sqrt(pa * (1 - pa) * pb * (1 - pb)), pa, pb);
  }
  legs.forEach((l, i) => { if (!used.has(i)) pAdj *= l.p; });
  const pInd = legs.reduce((a, l) => a * l.p, 1);
  const dec = legs.reduce((a, l) => a * l.dec, 1);
  return { legs, pInd, pAdj, dec, american: decimalToAmerican(dec), ev: pAdj * dec - 1 };
}

function* combinations(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i < arr.length; i++) { acc.push(arr[i]); yield* combinations(arr, k, i + 1, acc); acc.pop(); }
}

function buildDualParlays(analyses, propsByGame, legsN, mode = 'game') {
  const strongCands = [];
  const demonCands = [];

  for (const a of analyses) {
    if (!a.reliable) continue;
    if (mode === 'game' || mode === 'both') {
      for (const b of a.bets) {
        if (b.type === 'ML' && b.p >= 0.3 && b.p <= 0.6) strongCands.push(b);
        if (b.type === 'SPREAD' && b.p >= 0.46) strongCands.push(b);
        if (b.type === 'TOTAL' && b.p >= 0.5) strongCands.push(b);
      }
    }
    if (mode === 'player' || mode === 'both') {
      for (const pr of propsByGame[a.game.id] || []) {
        if (pr.estimated) continue;   // no real sportsbook line/price => not a bet, never a parlay leg
        if (pr.p >= 0.40 && !pr.questionable) {
          // Standard prop candidate for Option 1
          strongCands.push(pr);

          // PURE "DEMON" ALT PROP FOR OPTION 2 ONLY (Pushed higher line, lower probability, massive payout multiplier)
          const bump = pr.stat === 'points' ? 3.5 : 2.0;
          const altLine = pr.line + bump;
          const altP = 1 - normCdf((altLine - pr.proj) / pr.sd); // Harder to hit probability

          if (altP >= 0.15 && altP <= 0.48) {
            const altDec = Math.round((1 / (altP * 0.88)) * 100) / 100; // Scaled higher odds multiplier
            demonCands.push({
              ...pr,
              line: altLine,
              p: altP,
              dec: altDec,
              american: decimalToAmerican(altDec),
              altEstimated: true,   // odds are model-derived, NOT a bookmaker price
              label: `${pr.player} Over ${altLine} ${STAT_ABBR[pr.stat]} (🔥 DEMON ALT, est. odds)`
            });
          }
        }
      }
    }
  }

  if (strongCands.length < legsN) return { strong: null, risky: null };

  const sortedStrongCands = [...strongCands].sort((a, b) => (b.ev * 2 + b.p) - (a.ev * 2 + a.p));

  // 1. Option 1 (Strong Parlay): Built strictly from standard baseline props
  let bestStrong = null;
  for (const combo of combinations(sortedStrongCands, legsN)) {
    const r = evalCombo(combo);
    if (!r) continue;
    const strongScore = r.ev * 2 + r.pAdj;
    if (!bestStrong || strongScore > (bestStrong.ev * 2 + bestStrong.pAdj)) {
      bestStrong = r;
    }
  }

  if (!bestStrong) return { strong: null, risky: null };

  // 2. Option 2 (Risky / Lotto Parlay): Built EXCLUSIVELY from the 🔥 DEMON ALT high-risk lines
  let bestRisky = null;
  const sortedDemonCands = [...demonCands].sort((a, b) => b.dec - a.dec);

  if (sortedDemonCands.length >= legsN) {
    for (const combo of combinations(sortedDemonCands, legsN)) {
      const r = evalCombo(combo);
      if (!r) continue;
      if (!bestRisky || r.dec > bestRisky.dec) {
        bestRisky = r;
      }
    }
  }

  // Fallback if demon pool needs extra legs
  if (!bestRisky) {
    const fallbackPool = [...sortedStrongCands].reverse();
    bestRisky = evalCombo(fallbackPool.slice(0, legsN));
  }

  return { strong: bestStrong, risky: bestRisky };
}

module.exports = {
  SPORT_CFG, MIN_EV, modelWeight, clamp, normName, nameMatchScore, findKey,
  americanToDecimal, decimalToAmerican, americanToImplied, fmtAmerican, fmtLine, noVig, noVigPower, normalCover, normalOver, marginDist, distCover, poissonOver, expectedValue, kellyStake,
  normCdf, confidenceTier, teamRating, summarizeSchedule, situationAdjust, altitudeBoost, weatherTotalAdj, statusWeight, injuryPenalty, buildProfile, analyzeGame,
  projectPlayerStat, evaluateProp, buildProps, propLean, pickBestBets, buildSlip, safeLineFor, pickBestBetsClassic, evalCombo, buildDualParlays, STAT_ABBR, MARKET_KEY,
};
