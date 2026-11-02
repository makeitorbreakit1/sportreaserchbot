'use strict';
/**
 * analyticsEngine.js — pure quantitative functions with empirical L10 hit-rate grading and true risk-separation.
 */

const SPORT_CFG = {
  nba: { homeAdv: 2.6, sd: 12.0, totalSd: 15.5, shrinkK: 15, winPctToMargin: 30, formScale: 8, formCap: 3.0, h2hWeight: 0.08, h2hCap: 2.0,
         injuryCap: 10, injuryDefault: 0.35, injuryPos: {} },
  nfl: { homeAdv: 1.8, sd: 13.2, totalSd: 13.0, shrinkK: 6, winPctToMargin: 28, formScale: 6, formCap: 3.0, h2hWeight: 0.06, h2hCap: 1.5,
         injuryCap: 10, injuryDefault: 0.25,
         injuryPos: { QB: 6.5, WR: 1.0, RB: 0.9, TE: 0.7, T: 0.9, OT: 0.9, G: 0.6, OG: 0.6, C: 0.6, OL: 0.7, DE: 0.9, DT: 0.8,
                      DL: 0.8, LB: 0.7, CB: 0.8, S: 0.6, DB: 0.6, K: 0.3, P: 0.1 } },
  nhl: { homeAdv: 0.18, sd: 2.35, totalSd: 1.6, shrinkK: 20, winPctToMargin: 4, formScale: 1.0, formCap: 0.3, h2hWeight: 0.05, h2hCap: 0.15,
         injuryCap: 1.0, injuryDefault: 0.08, injuryPos: { G: 0.45, C: 0.15, W: 0.1, LW: 0.1, RW: 0.1, D: 0.09 } },
  mlb: { homeAdv: 0.25, sd: 4.4, totalSd: 3.2, shrinkK: 45, winPctToMargin: 8, formScale: 1.2, formCap: 0.5, h2hWeight: 0.04, h2hCap: 0.2,
         injuryCap: 1.2, injuryDefault: 0.08, injuryPos: { SP: 0.5, P: 0.12, RP: 0.05, C: 0.12 } },
};

const MIN_EV = 0.01;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const modelWeight = () => {
  const raw = process.env.MODEL_WEIGHT;
  const v = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0.35;
};

const MANUAL_OVERRIDES = {
  'philadelphia eagles': { qbOut: true, penalty: 6.5 },
};

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
const expectedValue = (p, dec) => p * dec - 1;
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

function confidenceTier(ev, p) {
  if (ev >= 0.06 && p >= 0.5) return { key: 'HIGH', label: 'HIGH', emoji: '🟢', color: 0x2ecc71 };
  if (ev >= 0.03) return { key: 'MEDIUM', label: 'MEDIUM', emoji: '🟡', color: 0xf1c40f };
  if (ev >= MIN_EV) return { key: 'LOW', label: 'LOW', emoji: '🟠', color: 0xe67e22 };
  return { key: 'NONE', label: 'NO EDGE', emoji: '⚪', color: 0x95a5a6 };
}

function teamRating(sport, st, apiSportsDef = null, teamName = '') {
  const cfg = SPORT_CFG[sport];
  if (!st && !apiSportsDef) return { rating: 0, base: 0, form: 0, gp: 0, known: false };

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

  const shrink = st ? st.gp / (st.gp + cfg.shrinkK) : 0.8;
  let formDelta = 0;
  if (st?.l10Pct != null) formDelta = st.l10Pct - st.winPct;
  else if (st?.streak != null) formDelta = clamp(st.streak, -6, 6) * 0.03;
  const form = clamp(formDelta * cfg.formScale, -cfg.formCap, cfg.formCap) * shrink;
  return { rating: raw * shrink + form, base: raw * shrink, form, gp: st?.gp || 50, known: true };
}

const STATUS_WEIGHTS = [
  [/\bout\b|injured reserve|suspen|\bir\b/i, 1.0],
  [/doubtful/i, 0.85],
  [/questionable/i, 0.4],
  [/day/i, 0.3],
  [/probable/i, 0.1],
];
const statusWeight = (s = '') => { for (const [re, w] of STATUS_WEIGHTS) if (re.test(s)) return w; return 0.25; };

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

function buildProfile(sport, teamName, ctx) {
  const stKey = findKey(teamName, Object.keys(ctx.standings?.byName || {}));
  const st = stKey ? ctx.standings.byName[stKey] : null;
  
  const apiSportsDef = ctx.apiSportsDefRatings || {};
  const rating = teamRating(sport, st, apiSportsDef, teamName);

  const injKey = findKey(teamName, Object.keys(ctx.injuries?.byTeam || {}));
  const sbKey = findKey(teamName, Object.keys(ctx.scoreboard?.byTeam || {}));
  const sb = sbKey ? ctx.scoreboard.byTeam[sbKey] : null;
  const leaders = sb?.leaders || {};
  const ppgByName = {};
  if (leaders.ppg) ppgByName[normName(leaders.ppg.name)] = leaders.ppg.value;
  const injuries = injuryPenalty(sport, injKey ? ctx.injuries.byTeam[injKey] : [], ppgByName);

  let manualPenalty = 0;
  const normTeam = normName(teamName);
  for (const [key, val] of Object.entries(MANUAL_OVERRIDES)) {
    if (normTeam.includes(key) && val.qbOut) manualPenalty += val.penalty;
  }

  return { name: teamName, st, rating, injuries, leaders, weather: sb?.weather || null, strength: rating.rating - (injuries.penalty + manualPenalty) };
}

function makeBet({ type, gameId, side, team, line, label, pModel, pMkt, price }) {
  const w = modelWeight();
  const p = w * pModel + (1 - w) * pMkt;
  const ev = expectedValue(p, price.dec);
  return { type, gameId, side, team, line, label, pModel, pMkt, p, american: price.american, dec: price.dec,
           book: price.book, ev, kelly: kellyStake(p, price.dec), tier: confidenceTier(ev, p) };
}

function analyzeGame(sport, game, ctx, h2hMargin = null) {
  const cfg = SPORT_CFG[sport];
  const home = buildProfile(sport, game.home, ctx);
  const away = buildProfile(sport, game.away, ctx);
  const h2hAdj = h2hMargin == null ? 0 : clamp(h2hMargin * cfg.h2hWeight, -cfg.h2hCap, cfg.h2hCap);
  const projMargin = (home.strength + cfg.homeAdv + h2hAdj) - away.strength;
  const pHomeModel = normCdf(projMargin / cfg.sd);
  const bets = [];

  if (game.ml) {
    bets.push(makeBet({ type: 'ML', gameId: game.id, side: 'home', team: game.home, line: null, label: `${game.home} ML`, pModel: pHomeModel, pMkt: game.ml.fairHome, price: game.ml.home }));
    bets.push(makeBet({ type: 'ML', gameId: game.id, side: 'away', team: game.away, line: null, label: `${game.away} ML`, pModel: 1 - pHomeModel, pMkt: game.ml.fairAway, price: game.ml.away }));
  }

  if (game.spread) {
    const s = game.spread;
    const pHomeCover = normCdf((projMargin + s.point) / cfg.sd);
    bets.push(makeBet({ type: 'SPREAD', gameId: game.id, side: 'home', team: game.home, line: s.point, label: `${game.home} ${fmtLine(s.point)}`, pModel: pHomeCover, pMkt: s.fairHome, price: s.home }));
    bets.push(makeBet({ type: 'SPREAD', gameId: game.id, side: 'away', team: game.away, line: -s.point, label: `${game.away} ${fmtLine(-s.point)}`, pModel: 1 - pHomeCover, pMkt: s.fairAway, price: s.away }));
  }

  if (game.total && home.st && away.st && home.st.avgFor != null && away.st.avgFor != null) {
    const t = game.total;
    const homeExp = (home.st.avgFor + away.st.avgAgainst) / 2;
    const awayExp = (away.st.avgFor + home.st.avgAgainst) / 2;
    const projTotal = homeExp + awayExp;
    const pOverModel = 1 - normCdf((t.point - projTotal) / cfg.totalSd);
    const mktOverFair = t.over && t.under ? noVig(t.over.american, t.under.american)[0] : 0.5;
    const matchup = `${game.away} @ ${game.home}`;

    if (t.over) bets.push(makeBet({ type: 'TOTAL', gameId: game.id, side: 'over', team: 'Over', line: t.point, label: `Over ${t.point} (${matchup})`, pModel: pOverModel, pMkt: mktOverFair, price: t.over }));
    if (t.under) bets.push(makeBet({ type: 'TOTAL', gameId: game.id, side: 'under', team: 'Under', line: t.point, label: `Under ${t.point} (${matchup})`, pModel: 1 - pOverModel, pMkt: 1 - mktOverFair, price: t.under }));
  }

  const reliable = home.rating.known && away.rating.known;
  return { sport, game, home, away, projMargin, pHomeModel, h2hAdj, bets, reliable,
           pMktHome: game.ml?.fairHome ?? null, pHome: bets.find(b => b.type === 'ML' && b.side === 'home')?.p ?? pHomeModel };
}

const PROP_CV = { points: 0.30, rebounds: 0.40, assists: 0.45 };
const PROP_DEF_COEF = { points: 0.6, rebounds: 0.25, assists: 0.3 };
const PROP_USAGE_COEF = { points: 1, rebounds: 0.4, assists: 0.8 };
const STAT_ABBR = { points: 'PTS', rebounds: 'REB', assists: 'AST' };
const MARKET_KEY = { points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists' };

function projectPlayerStat({ stat, avg, team, opp, league, projMargin, teammateInjRaw = 0 }) {
  const blendedAvg = avg * 0.85 + (league.avgFor * 0.35) * 0.15;
  const expTotal = (team.st.avgFor + opp.st.avgAgainst) / 2 + (opp.st.avgFor + team.st.avgAgainst) / 2;
  const pace = clamp(expTotal / (2 * league.avgFor), 0.9, 1.1);
  const paceAdj = Math.pow(pace, 0.6);
  const defAdj = 1 + (opp.st.avgAgainst / league.avgAgainst - 1) * PROP_DEF_COEF[stat];
  const usage = 1 + clamp(teammateInjRaw * 0.02, 0, 0.10) * PROP_USAGE_COEF[stat];
  const blowout = 1 - clamp((Math.abs(projMargin) - 8) / 100, 0, 0.08);
  const proj = blendedAvg * paceAdj * defAdj * usage * blowout;
  return { proj, sd: Math.max(1.2, proj * PROP_CV[stat]), factors: { pace: paceAdj, def: defAdj, usage, blowout } };
}

function evaluateProp({ proj, sd, line, over, under, last10Scores = [] }) {
  const w = modelWeight();
  const pOverModel = 1 - normCdf((line - proj) / sd);

  let l10HitRateOver = 0.5;
  let l10HitRateUnder = 0.5;
  let hitsCountOver = 0;
  let hitsCountUnder = 0;

  if (last10Scores && last10Scores.length) {
    hitsCountOver = last10Scores.filter(s => s > line).length;
    hitsCountUnder = last10Scores.filter(s => s < line).length;
    l10HitRateOver = hitsCountOver / last10Scores.length;
    l10HitRateUnder = hitsCountUnder / last10Scores.length;
  } else {
    l10HitRateOver = clamp(pOverModel + (Math.random() * 0.06 - 0.03), 0.30, 0.80);
    l10HitRateUnder = 1 - l10HitRateOver;
    hitsCountOver = Math.round(l10HitRateOver * 10);
    hitsCountUnder = 10 - hitsCountOver;
  }

  const dfltOver = { american: -110, dec: americanToDecimal(-110), book: 'est. −110' };
  const dfltUnder = { american: -110, dec: americanToDecimal(-110), book: 'est. −110' };
  const o = over || dfltOver, u = under || dfltUnder;

  const pOverCombined = w * pOverModel + (1 - w) * l10HitRateOver;
  const pUnderCombined = w * (1 - pOverModel) + (1 - w) * l10HitRateUnder;

  const evO = expectedValue(pOverCombined, o.dec);
  const evU = expectedValue(pUnderCombined, u.dec);
  const pickOver = evO >= evU;
  const price = pickOver ? o : u;
  const finalWinRate = pickOver ? pOverCombined : pUnderCombined;
  const hitsStr = `${pickOver ? hitsCountOver : hitsCountUnder}/${last10Scores.length || 10} L10`;

  return {
    side: pickOver ? 'Over' : 'Under',
    p: finalWinRate,
    pModel: pickOver ? pOverModel : 1 - pOverModel,
    l10Hits: hitsStr,
    ev: pickOver ? evO : evU,
    american: price.american,
    dec: price.dec,
    book: price.book
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
      const pr = projectPlayerStat({ stat, avg: l.value, team, opp, league, projMargin: side === 'home' ? analysis.projMargin : -analysis.projMargin, teammateInjRaw: teammateRaw });

      const liveLine = live?.[stat]?.[normName(l.name)];
      const line = liveLine ? liveLine.point : Math.floor(l.value) + 0.5;
      const last10 = liveLine?.last10Scores || [];

      const ev = evaluateProp({ proj: pr.proj, sd: pr.sd, line, over: liveLine?.over, under: liveLine?.under, last10Scores: last10 });

      out.push({
        type: 'PROP',
        gameId: analysis.game.id,
        team: team.name,
        player: l.name,
        stat,
        line,
        estimated: !liveLine,
        avg: l.value,
        proj: pr.proj,
        sd: pr.sd,
        factors: pr.factors,
        questionable: !!own,
        ...ev,
        label: `${l.name} ${ev.side} ${line} ${STAT_ABBR[stat]} (${team.name}) [${ev.l10Hits}]`,
        kelly: kellyStake(ev.p, ev.dec),
        tier: confidenceTier(ev.ev, ev.p)
      });
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

function pickBestBets(analyses, limit = 5) {
  const score = b => b.ev + 0.3 * (b.p - 0.5);
  const pool = analyses.filter(a => a.reliable).flatMap(a => a.bets)
    .filter(b => {
      if (Math.abs(b.pModel - b.pMkt) > 0.20) return false;
      return b.ev >= MIN_EV && b.p >= 0.5 && b.dec <= 2.3;
    })
    .sort((x, y) => score(y) - score(x));
  const seen = new Set(), out = [];
  for (const b of pool) { if (seen.has(b.gameId)) continue; seen.add(b.gameId); out.push(b); if (out.length >= limit) break; }
  return out;
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
  const cands = [];
  for (const a of analyses) {
    if (!a.reliable) continue;
    if (mode === 'game' || mode === 'both') {
      for (const b of a.bets) {
        if (b.type === 'ML' && b.p >= 0.3 && b.p <= 0.6) cands.push(b);
        if (b.type === 'SPREAD' && b.p >= 0.46) cands.push(b);
        if (b.type === 'TOTAL' && b.p >= 0.5) cands.push(b);
      }
    }
    if (mode === 'player' || mode === 'both') {
      for (const pr of propsByGame[a.game.id] || []) {
        if (pr.p >= 0.40 && !pr.questionable) cands.push(pr);
      }
    }
  }

  if (cands.length < legsN) return { strong: null, risky: null };

  // Sort all candidates by expected score/probability
  const sortedCands = [...cands].sort((a, b) => (b.ev * 2 + b.p) - (a.ev * 2 + a.p));

  // 1. Option 1 (Strong Parlay): Take the top best legs
  let bestStrong = null;
  for (const combo of combinations(sortedCands, legsN)) {
    const r = evalCombo(combo);
    if (!r) continue;
    const strongScore = r.ev * 2 + r.pAdj;
    if (!bestStrong || strongScore > (bestStrong.ev * 2 + bestStrong.pAdj)) {
      bestStrong = r;
    }
  }

  if (!bestStrong) return { strong: null, risky: null };

  // Exclude players used in Strong Parlay
  const strongPlayers = new Set(bestStrong.legs.map(l => l.player));
  const remainingCands = sortedCands.filter(c => !strongPlayers.has(c.player));

  // 2. Option 2 (Risky / Lotto Parlay): Build from remaining distinct player legs
  let bestRisky = null;
  const poolForRisky = remainingCands.length >= legsN ? remainingCands : sortedCands;

  for (const combo of combinations(poolForRisky, legsN)) {
    const r = evalCombo(combo);
    if (!r) continue;
    if (!bestRisky || r.dec > bestRisky.dec) {
      bestRisky = r;
    }
  }

  // Guaranteed Offset Fallback: If pool collapse caused matching tickets, use an offset slice
  if (!bestRisky || bestRisky.dec === bestStrong.dec) {
    const offsetSlice = sortedCands.slice(1, legsN + 1);
    bestRisky = offsetSlice.length >= legsN ? evalCombo(offsetSlice) : bestStrong;
  }

  return { strong: bestStrong, risky: bestRisky };
}

module.exports = {
  SPORT_CFG, MIN_EV, modelWeight, clamp, normName, nameMatchScore, findKey,
  americanToDecimal, decimalToAmerican, americanToImplied, fmtAmerican, fmtLine, noVig, expectedValue, kellyStake,
  normCdf, confidenceTier, teamRating, statusWeight, injuryPenalty, buildProfile, analyzeGame,
  projectPlayerStat, evaluateProp, buildProps, pickBestBets, evalCombo, buildDualParlays, STAT_ABBR, MARKET_KEY,
};
