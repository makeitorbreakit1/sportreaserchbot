'use strict';
/**
 * analyticsEngine.js — pure functions, no network I/O.
 *
 * Pipeline per game:
 *   standings → shrunken power rating (+ form) → minus injury penalty → + home-field edge (+ H2H nudge)
 *   → projected margin → Normal(margin, σ_sport) → win % and spread-cover %
 *   → blended with de-vigged market probability → EV vs best available price.
 */

// ───────────────────────── Sport configuration ─────────────────────────
// Margin units: points (NBA/NFL), goals (NHL), runs (MLB). sd = std-dev of final margin.
const SPORT_CFG = {
  nba: { homeAdv: 2.6, sd: 12.0, shrinkK: 15, winPctToMargin: 30, formScale: 8, formCap: 3.0, h2hWeight: 0.08, h2hCap: 2.0,
         injuryCap: 10, injuryDefault: 0.35, injuryPos: {} },
  nfl: { homeAdv: 1.8, sd: 13.2, shrinkK: 6, winPctToMargin: 28, formScale: 6, formCap: 3.0, h2hWeight: 0.06, h2hCap: 1.5,
         injuryCap: 10, injuryDefault: 0.25,
         injuryPos: { QB: 6.5, WR: 1.0, RB: 0.9, TE: 0.7, T: 0.9, OT: 0.9, G: 0.6, OG: 0.6, C: 0.6, OL: 0.7, DE: 0.9, DT: 0.8,
                      DL: 0.8, LB: 0.7, CB: 0.8, S: 0.6, DB: 0.6, K: 0.3, P: 0.1 } },
  nhl: { homeAdv: 0.18, sd: 2.35, shrinkK: 20, winPctToMargin: 4, formScale: 1.0, formCap: 0.3, h2hWeight: 0.05, h2hCap: 0.15,
         injuryCap: 1.0, injuryDefault: 0.08, injuryPos: { G: 0.45, C: 0.15, W: 0.1, LW: 0.1, RW: 0.1, D: 0.09 } },
  mlb: { homeAdv: 0.25, sd: 4.4, shrinkK: 45, winPctToMargin: 8, formScale: 1.2, formCap: 0.5, h2hWeight: 0.04, h2hCap: 0.2,
         injuryCap: 1.2, injuryDefault: 0.08, injuryPos: { SP: 0.5, P: 0.12, RP: 0.05, C: 0.12 } },
};

const MIN_EV = 0.01; // 1% minimum blended edge to be called "+EV"
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const modelWeight = () => {
  const raw = process.env.MODEL_WEIGHT;
  const v = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0.35;
};

// ───────────────────────── Manual Injury & Starter Overrides ─────────────────────────
// Add manual overrides here when starting QBs or key players are ruled out and API feeds lag.
const MANUAL_OVERRIDES = {
  'philadelphia eagles': { qbOut: true, penalty: 6.5 },
  // 'team name': { qbOut: true, penalty: 5.0 }
};

// ───────────────────────── Name helpers ─────────────────────────
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

// ───────────────────────── Odds math ─────────────────────────
const americanToDecimal = a => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const decimalToAmerican = d => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const americanToImplied = a => 1 / americanToDecimal(a);
const fmtAmerican = a => (a > 0 ? `+${a}` : `${a}`);
const fmtLine = n => (n > 0 ? `+${n}` : `${n}`);
/** Remove the bookmaker margin from a two-way market → fair probabilities that sum to 1. */
function noVig(a1, a2) {
  const i1 = americanToImplied(a1), i2 = americanToImplied(a2), s = i1 + i2;
  return [i1 / s, i2 / s];
}
const expectedValue = (p, dec) => p * dec - 1; // per $1 staked
function kellyStake(p, dec, fraction = 0.25, cap = 0.02) {
  const b = dec - 1;
  return clamp(((b * p - (1 - p)) / b) * fraction, 0, cap);
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |err| < 1.5e-7)
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

function confidenceTier(ev, p) {
  if (ev >= 0.06 && p >= 0.5) return { key: 'HIGH', label: 'HIGH', emoji: '🟢', color: 0x2ecc71 };
  if (ev >= 0.03) return { key: 'MEDIUM', label: 'MEDIUM', emoji: '🟡', color: 0xf1c40f };
  if (ev >= MIN_EV) return { key: 'LOW', label: 'LOW', emoji: '🟠', color: 0xe67e22 };
  return { key: 'NONE', label: 'NO EDGE', emoji: '⚪', color: 0x95a5a6 };
}

// ───────────────────────── Power rating ─────────────────────────
/**
 * Rating = points-per-game margin vs. an average team, shrunk toward 0 by gp/(gp+K) so small samples
 * (early season) don't produce wild numbers, plus a capped recent-form adjustment (last 10 vs season win%).
 */
function teamRating(sport, st) {
  const cfg = SPORT_CFG[sport];
  if (!st) return { rating: 0, base: 0, form: 0, gp: 0, known: false };
  const raw = st.avgFor != null && st.avgAgainst != null
    ? st.avgFor - st.avgAgainst
    : (st.winPct - 0.5) * cfg.winPctToMargin;
  const shrink = st.gp / (st.gp + cfg.shrinkK);
  let formDelta = 0;
  if (st.l10Pct != null) formDelta = st.l10Pct - st.winPct;
  else if (st.streak != null) formDelta = clamp(st.streak, -6, 6) * 0.03;
  const form = clamp(formDelta * cfg.formScale, -cfg.formCap, cfg.formCap) * shrink;
  return { rating: raw * shrink + form, base: raw * shrink, form, gp: st.gp, known: true };
}

// ───────────────────────── Injury subtraction model ─────────────────────────
const STATUS_WEIGHTS = [
  [/\bout\b|injured reserve|suspen|\bir\b/i, 1.0],
  [/doubtful/i, 0.85],
  [/questionable/i, 0.4],
  [/day/i, 0.3],
  [/probable/i, 0.1],
];
const statusWeight = (s = '') => { for (const [re, w] of STATUS_WEIGHTS) if (re.test(s)) return w; return 0.25; };

/**
 * impact_i = positionValue_i × P(missing_i). NBA stars are valued by usage proxy (PPG × 0.17 net-rating pts).
 * Total is passed through cap × (1 − e^(−x/cap)) so a long injury list has diminishing returns.
 */
function injuryPenalty(sport, injuries = [], ppgByName = {}) {
  const cfg = SPORT_CFG[sport];
  const items = [];
  for (const inj of injuries) {
    const w = statusWeight(inj.status);
    const pos = String(inj.pos || '').toUpperCase();
    let base = cfg.injuryPos[pos] ?? cfg.injuryDefault;
    const ppg = ppgByName[normName(inj.name)];
    if (sport === 'nba' && ppg >= 12) base = Math.max(base, ppg * 0.17);
    items.push({ name: inj.name, pos, status: inj.status, weight: w, base, impact: base * w });
  }
  items.sort((a, b) => b.impact - a.impact);
  const raw = items.reduce((s, i) => s + i.impact, 0);
  return { penalty: cfg.injuryCap * (1 - Math.exp(-raw / cfg.injuryCap)), raw, items };
}

// ───────────────────────── Game model ─────────────────────────
function buildProfile(sport, teamName, ctx) {
  const stKey = findKey(teamName, Object.keys(ctx.standings?.byName || {}));
  const st = stKey ? ctx.standings.byName[stKey] : null;
  const rating = teamRating(sport, st);
  const injKey = findKey(teamName, Object.keys(ctx.injuries?.byTeam || {}));
  const sbKey = findKey(teamName, Object.keys(ctx.scoreboard?.byTeam || {}));
  const sb = sbKey ? ctx.scoreboard.byTeam[sbKey] : null;
  const leaders = sb?.leaders || {};
  const ppgByName = {};
  if (leaders.ppg) ppgByName[normName(leaders.ppg.name)] = leaders.ppg.value;
  const injuries = injuryPenalty(sport, injKey ? ctx.injuries.byTeam[injKey] : [], ppgByName);

  // Check manual overrides for unmodeled or late-breaking injuries (e.g. starting QB out)
  let manualPenalty = 0;
  const normTeam = normName(teamName);
  for (const [key, val] of Object.entries(MANUAL_OVERRIDES)) {
    if (normTeam.includes(key) && val.qbOut) {
      manualPenalty += val.penalty;
    }
  }

  return { name: teamName, st, rating, injuries, leaders, weather: sb?.weather || null,
           strength: rating.rating - (injuries.penalty + manualPenalty) };
}

function makeBet({ type, gameId, side, team, line, label, pModel, pMkt, price }) {
  const w = modelWeight();
  const p = w * pModel + (1 - w) * pMkt; // shrink toward the market to avoid phantom edges
  const ev = expectedValue(p, price.dec);
  return { type, gameId, side, team, line, label, pModel, pMkt, p, american: price.american, dec: price.dec,
           book: price.book, ev, kelly: kellyStake(p, price.dec), tier: confidenceTier(ev, p) };
}

function analyzeGame(sport, game, ctx, h2hMargin = null) {
  const cfg = SPORT_CFG[sport];
  const home = buildProfile(sport, game.home, ctx);
  const away = buildProfile(sport, game.away, ctx);
  const h2hAdj = h2hMargin == null ? 0 : clamp(h2hMargin * cfg.h2hWeight, -cfg.h2hCap, cfg.h2hCap);
  const projMargin = (home.strength + cfg.homeAdv + h2hAdj) - away.strength; // + = home wins by that much
  const pHomeModel = normCdf(projMargin / cfg.sd);
  const bets = [];

  if (game.ml) {
    bets.push(makeBet({ type: 'ML', gameId: game.id, side: 'home', team: game.home, line: null, label: `${game.home} ML`,
      pModel: pHomeModel, pMkt: game.ml.fairHome, price: game.ml.home }));
    bets.push(makeBet({ type: 'ML', gameId: game.id, side: 'away', team: game.away, line: null, label: `${game.away} ML`,
      pModel: 1 - pHomeModel, pMkt: game.ml.fairAway, price: game.ml.away }));
  }
  if (game.spread) {
    const s = game.spread;
    const pHomeCover = normCdf((projMargin + s.point) / cfg.sd); // home covers if margin + spread > 0
    bets.push(makeBet({ type: 'SPREAD', gameId: game.id, side: 'home', team: game.home, line: s.point,
      label: `${game.home} ${fmtLine(s.point)}`, pModel: pHomeCover, pMkt: s.fairHome, price: s.home }));
    bets.push(makeBet({ type: 'SPREAD', gameId: game.id, side: 'away', team: game.away, line: -s.point,
      label: `${game.away} ${fmtLine(-s.point)}`, pModel: 1 - pHomeCover, pMkt: s.fairAway, price: s.away }));
  }
  const reliable = home.rating.known && away.rating.known;
  return { sport, game, home, away, projMargin, pHomeModel, h2hAdj, bets, reliable,
           pMktHome: game.ml?.fairHome ?? null, pHome: bets.find(b => b.type === 'ML' && b.side === 'home')?.p ?? pHomeModel };
}

// ───────────────────────── Player props (NBA) ─────────────────────────
const PROP_CV = { points: 0.30, rebounds: 0.40, assists: 0.45 };          // coefficient of variation (game-to-game)
const PROP_DEF_COEF = { points: 0.6, rebounds: 0.25, assists: 0.3 };      // sensitivity to opponent defense
const PROP_USAGE_COEF = { points: 1, rebounds: 0.4, assists: 0.8 };       // sensitivity to teammate absences
const STAT_ABBR = { points: 'PTS', rebounds: 'REB', assists: 'AST' };
const MARKET_KEY = { points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists' };

/** proj = seasonAvg × pace^0.6 × oppDefense × usage(teammate injuries) × blowout-minutes factor */
function projectPlayerStat({ stat, avg, team, opp, league, projMargin, teammateInjRaw = 0 }) {
  const expTotal = (team.st.avgFor + opp.st.avgAgainst) / 2 + (opp.st.avgFor + team.st.avgAgainst) / 2;
  const pace = clamp(expTotal / (2 * league.avgFor), 0.9, 1.1);
  const paceAdj = Math.pow(pace, 0.6);
  const defAdj = 1 + (opp.st.avgAgainst / league.avgAgainst - 1) * PROP_DEF_COEF[stat];
  const usage = 1 + clamp(teammateInjRaw * 0.02, 0, 0.10) * PROP_USAGE_COEF[stat];
  const blowout = 1 - clamp((Math.abs(projMargin) - 8) / 100, 0, 0.08);
  const proj = avg * paceAdj * defAdj * usage * blowout;
  return { proj, sd: Math.max(1.2, proj * PROP_CV[stat]), factors: { pace: paceAdj, def: defAdj, usage, blowout } };
}

function evaluateProp({ proj, sd, line, over, under }) {
  const w = modelWeight();
  const pOverModel = 1 - normCdf((line - proj) / sd);
  const pMktOver = over && under ? noVig(over.american, under.american)[0] : 0.5;
  const dflt = { american: -110, dec: americanToDecimal(-110), book: 'est. −110' };
  const o = over || dflt, u = under || dflt;
  const pOver = w * pOverModel + (1 - w) * pMktOver;
  const evO = expectedValue(pOver, o.dec), evU = expectedValue(1 - pOver, u.dec);
  const pickOver = evO >= evU;
  const price = pickOver ? o : u;
  return { side: pickOver ? 'Over' : 'Under', p: pickOver ? pOver : 1 - pOver, pModel: pickOver ? pOverModel : 1 - pOverModel,
           ev: pickOver ? evO : evU, american: price.american, dec: price.dec, book: price.book };
}

/**
 * Props for the (≤3) season leaders ESPN lists per team on the scoreboard.
 * `live` (optional) = real sportsbook lines { points:{normName:{point,over,under}}, ... }; otherwise the line is
 * ESTIMATED as the nearest half-point at/below the season average, which is how books typically anchor it.
 */
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
      if (own && own.weight >= 0.85) continue;                       // ruled out / doubtful → skip
      const teammateRaw = Math.max(0, team.injuries.raw - (own ? own.impact : 0));
      const pr = projectPlayerStat({ stat, avg: l.value, team, opp, league, projMargin: side === 'home' ? analysis.projMargin : -analysis.projMargin, teammateInjRaw: teammateRaw });
      const liveLine = live?.[stat]?.[normName(l.name)];
      const line = liveLine ? liveLine.point : Math.floor(l.value) + 0.5;
      const ev = evaluateProp({ proj: pr.proj, sd: pr.sd, line, over: liveLine?.over, under: liveLine?.under });
      out.push({ type: 'PROP', gameId: analysis.game.id, team: team.name, player: l.name, stat, line, estimated: !liveLine,
        avg: l.value, proj: pr.proj, sd: pr.sd, factors: pr.factors, questionable: !!own, ...ev,
        label: `${l.name} ${ev.side} ${line} ${STAT_ABBR[stat]}`, kelly: kellyStake(ev.p, ev.dec), tier: confidenceTier(ev.ev, ev.p) });
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

// ───────────────────────── Best bets & parlay lineup ─────────────────────────
/** Conservative mode: single, lower-variance (p ≥ 50%, price ≤ +130) bets with positive blended EV; 1 per game. */
function pickBestBets(analyses, limit = 5) {
  const score = b => b.ev + 0.3 * (b.p - 0.5);
  const pool = analyses.filter(a => a.reliable).flatMap(a => a.bets)
    .filter(b => {
      // Market discrepancy guard: filter out bets where model vs market divergence > 20%
      // to prevent recommending picks where unmodeled news (like late injuries) distorts edge.
      if (Math.abs(b.pModel - b.pMkt) > 0.20) return false;
      return b.ev >= MIN_EV && b.p >= 0.5 && b.dec <= 2.3;
    })
    .sort((x, y) => score(y) - score(x));
  const seen = new Set(), out = [];
  for (const b of pool) { if (seen.has(b.gameId)) continue; seen.add(b.gameId); out.push(b); if (out.length >= limit) break; }
  return out;
}

/** Same-game legs are only allowed as (team-side leg, same-team player OVER) with positive correlation ρ. */
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
    // P(A∩B) = pA·pB + ρ·√(pA qA pB qB)  (Bernoulli correlation), bounded by the Fréchet upper limit
    pAdj *= Math.min(pa * pb + rho * Math.sqrt(pa * (1 - pa) * pb * (1 - pb)), pa, pb);
  }
  legs.forEach((l, i) => { if (!used.has(i)) pAdj *= l.p; });
  const pInd = legs.reduce((a, l) => a * l.p, 1);          // P1 × P2 × P3 …
  const dec = legs.reduce((a, l) => a * l.dec, 1);
  return { legs, pInd, pAdj, dec, american: decimalToAmerican(dec), ev: pAdj * dec - 1 };
}

function* combinations(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i < arr.length; i++) { acc.push(arr[i]); yield* combinations(arr, k, i + 1, acc); acc.pop(); }
}

/** High-risk mode: searches legs from a diverse candidate pool for the highest parlay EV that still pays well. */
function buildLineup(analyses, propsByGame, legsN) {
  const cands = [];
  for (const a of analyses) {
    if (!a.reliable) continue;
    for (const b of a.bets) {
      if (b.type === 'ML' && b.p >= 0.3 && b.p <= 0.6) cands.push(b);
      if (b.type === 'SPREAD' && b.p >= 0.46) cands.push(b);
    }
    for (const pr of propsByGame[a.game.id] || []) if (pr.p >= 0.5 && !pr.questionable) cands.push(pr);
  }
  const top = (type, n) => cands.filter(c => c.type === type).sort((a, b) => b.ev - a.ev).slice(0, n);
  const pool = [...top('PROP', 7), ...top('ML', 6), ...top('SPREAD', 5)];
  if (pool.length < legsN) return null;

  const minDec = Math.pow(1.75, legsN); // "high payout": rules out heavy-chalk parlays
  let best = null, bestAny = null;
  for (const combo of combinations(pool, legsN)) {
    const r = evalCombo(combo);
    if (!r) continue;
    if (!bestAny || r.ev > bestAny.ev) bestAny = r;
    if (r.dec >= minDec && (!best || r.ev > best.ev)) best = r;
  }
  return best || bestAny;
}

module.exports = {
  SPORT_CFG, MIN_EV, modelWeight, clamp, normName, nameMatchScore, findKey,
  americanToDecimal, decimalToAmerican, americanToImplied, fmtAmerican, fmtLine, noVig, expectedValue, kellyStake,
  normCdf, confidenceTier, teamRating, statusWeight, injuryPenalty, buildProfile, analyzeGame,
  projectPlayerStat, evaluateProp, buildProps, pickBestBets, evalCombo, buildLineup, STAT_ABBR, MARKET_KEY,
};
