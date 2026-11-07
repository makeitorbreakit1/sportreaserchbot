'use strict';
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { HARD_LIMIT_MESSAGE, ApiHardLimitError, usageSnapshot, cooldownRemaining } = require('../cache/cacheManager');
const { fmtAmerican, fmtLine, confidenceTier, MIN_EV, STAT_ABBR } = require('../services/analyticsEngine');

const NOTE = 'Educational analytics, not financial advice. 21+. Problem gambling? 1-800-GAMBLER';
const pct = (p, d = 1) => `${(p * 100).toFixed(d)}%`;
const probBar = (p, size = 10) => { const f = Math.round(Math.min(1, Math.max(0, p)) * size); return '▰'.repeat(f) + '▱'.repeat(size - f); };
const evText = ev => `${ev >= 0 ? '+' : ''}${(ev * 100).toFixed(1)}%`;

// Safe UNIX timestamp helper that handles ISO strings, UNIX numbers, or undefined values gracefully
const unix = rawDate => {
  if (!rawDate) return Math.floor(Date.now() / 1000);
  const parsed = Date.parse(rawDate);
  return isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000);
};

const mmss = s => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
const trim = (s, n = 1000) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function base(color) {
  const u = usageSnapshot('odds');
  return new EmbedBuilder().setColor(color).setTimestamp()
    .setFooter({ text: `Odds credits: ${u.daily.used}/${u.daily.limit} today · ${u.monthly.used}/${u.monthly.limit} this month\n${NOTE}` });
}

function banner(meta = {}) {
  const lines = [];
  if (meta.blocked) lines.push(HARD_LIMIT_MESSAGE);
  else if (meta.stale) lines.push('ℹ️ Some inputs are served from cache (older than their normal refresh window).');
  if (meta.missing?.length) lines.push(`ℹ️ No live ${meta.missing.join(' / ')} data. Those inputs were treated as neutral.`);
  return lines.length ? lines.join('\n') + '\n\n' : '';
}

function errorEmbed(title, description) {
  return new EmbedBuilder().setColor(0xe74c3c).setTitle(title).setDescription(description);
}

/** Returns true (and replies) if the user is still on cooldown. */
async function onCooldown(interaction) {
  const left = cooldownRemaining(interaction.user.id);
  if (left <= 0) return false;
  await interaction.reply({ content: `⏳ Cooldown active. You can run another command in **${mmss(left)}** (this protects the free API quota).`, flags: MessageFlags.Ephemeral });
  return true;
}

/** Unified error handler for deferred interactions. Returns true if it was a hard-limit stop. */
async function replyWithError(interaction, err) {
  if (err instanceof ApiHardLimitError) {
    const scope = err.scope === 'monthly' ? 'monthly' : 'daily';
    await interaction.editReply({ embeds: [errorEmbed('⚠️ API hard limit reached',
      `${HARD_LIMIT_MESSAGE}\n\nNo cached data exists yet for this request, so there is nothing to serve. (${err.provider} ${scope} cap)`)] });
    return true;
  }
  console.error('[command error]', err);
  await interaction.editReply({ embeds: [errorEmbed('❌ Something went wrong',
    err.message?.includes('ODDS_API_KEY') ? 'The Odds API key is not configured on the server.' : 'A data source failed to respond. Try again later.')] }).catch(() => {});
  return false;
}

const injLine = it => `${it.weight >= 0.85 ? '🔴' : it.weight >= 0.3 ? '🟠' : '🟡'} ${it.name}${it.pos ? ` (${it.pos})` : ''} — ${it.status || 'Listed'} · −${it.impact.toFixed(2)}`;

function analyzeEmbed(a, props = [], meta = {}) {
  const homeName = a.home?.name || a.game?.home || 'Home Team';
  const awayName = a.away?.name || a.game?.away || 'Away Team';
  const commence = a.game?.commenceTime || a.game?.commence_time || a.game?.commence;

  const best = [...(a.bets || [])].sort((x, y) => y.ev - x.ev)[0];
  const tier = best ? confidenceTier(best.ev, best.p) : confidenceTier(0, 0.5);
  const unit = a.sport === 'nhl' ? 'goals' : a.sport === 'mlb' ? 'runs' : 'pts';
  const e = base(tier.color).setTitle(`🏟️ ${awayName} @ ${homeName}`);
  const fav = (a.projMargin >= 0) ? homeName : awayName;
  
  let desc = banner(meta) + `Starts <t:${unix(commence)}:F>\nModel projection: **${fav} by ${Math.abs(a.projMargin || 0).toFixed(1)} ${unit}**`;
  if (a.venue) desc += `\n📍 ${a.venue.name}${a.venue.city ? `, ${a.venue.city}` : ''}`;
  const dr = a.drivers;
  if (dr) {
    const f = x => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;
    desc += `\nDrivers (to ${homeName}): ratings ${f(dr.ratings)} · home/venue ${f(dr.homeAdv)} · injuries ${f(dr.injuries)} · rest/travel ${f(dr.situation)}${dr.h2h ? ` · H2H ${f(dr.h2h)}` : ''}`;
  }
  if (!a.reliable) desc += '\n⚠️ Missing standings data for one team. Probabilities below are NOT reliable.';
  e.setDescription(desc);

  const ml = (a.bets || []).filter(b => b.type === 'ML');
  if (ml.length) {
    const h = ml.find(b => b.side === 'home') || ml[0];
    const w = ml.find(b => b.side === 'away') || ml[1] || ml[0];
    e.addFields({ name: '📈 Win probability (blended)', value: trim(
      `**${homeName}** ${probBar(h.p)} ${pct(h.p)}\n**${awayName}** ${probBar(w.p)} ${pct(w.p)}\n` +
      `Home: model ${pct(h.pModel)} · market ${pct(h.pMkt)} · blend ${pct(h.p)}\n` +
      ml.map(b => `${b.team}: ${fmtAmerican(b.american)} @ ${b.book} → EV ${evText(b.ev)}`).join('\n')) });
  }

  const sp = (a.bets || []).filter(b => b.type === 'SPREAD');
  if (sp.length) {
    const s = [...sp].sort((x, y) => y.ev - x.ev)[0];
    e.addFields({ name: '🎯 Spread recommendation', value: trim(
      `${s.ev >= MIN_EV ? '✅' : '➖'} **${s.label}** (${fmtAmerican(s.american)} @ ${s.book})\n` +
      `Cover ${probBar(s.p)} **${pct(s.p)}** (model ${pct(s.pModel)}, market ${pct(s.pMkt)})\n` +
      `EV ${evText(s.ev)} · ${s.ev >= MIN_EV ? `¼-Kelly ${pct(s.kelly, 2)} of bankroll` : 'no edge: pass'}`) });
  }

  const tot = (a.bets || []).filter(b => b.type === 'TOTAL');
  if (tot.length) {
    const t = [...tot].sort((x, y) => y.ev - x.ev)[0];
    e.addFields({ name: '📊 Total Points recommendation', value: trim(
      `${t.ev >= MIN_EV ? '✅' : '➖'} **${t.label}** — ${fmtAmerican(t.american)} @ ${t.book}\n` +
      `Hit rate ${probBar(t.p)} **${pct(t.p)}** (model ${pct(t.pModel)}, market ${pct(t.pMkt)})\n` +
      `EV ${evText(t.ev)} · ${t.ev >= MIN_EV ? `¼-Kelly ${pct(t.kelly, 2)} of bankroll` : 'no edge: pass'}`) });
  }

  e.addFields({ name: `${tier.emoji} Confidence: ${tier.label}`, value: best && best.ev >= MIN_EV
    ? `Best edge: **${best.label}** (${fmtAmerican(best.american)}) at ${evText(best.ev)} EV`
    : 'No bet clears the +1% EV threshold after blending with the market. **Pass.**' });

  for (const side of ['home', 'away']) {
    const t = a[side];
    if (t) {
      const items = (t.injuries?.items || []).filter(i => i.weight >= 0.25).slice(0, 4);
      const rating = t.rating?.rating || 0;
      const penalty = t.injuries?.penalty || 0;
      e.addFields({ name: `🩹 ${t.name || (side === 'home' ? homeName : awayName)} (rating ${rating >= 0 ? '+' : ''}${rating.toFixed(1)}, injuries −${penalty.toFixed(1)})`,
        value: items.length ? trim(items.map(injLine).join('\n')) : 'No significant injuries listed', inline: true });
    }
  }

  for (const side of ['away', 'home']) {
    const t = a[side];
    const sc = t?.sched, sit = t?.situation;
    if (!sc) continue;
    const l = sc.l10, sg = x => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
    const lines = [
      `**Last ${l.n}:** ${l.w}-${l.l} · ${sg(l.rawMargin)} avg margin (season ${sg(l.seasonMargin)}) · scoring ${l.pf.toFixed(1)}–${l.pa.toFixed(1)}`,
      ...(sit?.notes || []).map(n => `• ${n}`),
      ...(sit && Math.abs(sit.adj) >= 0.05 ? [`Net situation adjustment: ${sg(sit.adj)} ${unit}`] : []),
    ];
    e.addFields({ name: `📆 ${t.name} — ${side === 'home' ? 'home' : 'away'} form & situation`, value: trim(lines.join('\n')), inline: true });
  }
  if (a.totalNotes?.length) e.addFields({ name: '🔢 Total inputs', value: trim(`Model total ${a.modelTotal?.toFixed(1)} · ` + a.totalNotes.join(' · ')) });

  if (props && props.length) {
    const ranked = [...props].sort((x, y) => (x.estimated - y.estimated) || (y.ev - x.ev)).slice(0, 3);
    e.addFields({ name: '🏀 Player props (top 3)', value: trim(ranked.map(p => p.estimated
      ? `**${p.player} ${STAT_ABBR[p.stat]}** (${p.team}) — proj ${p.proj.toFixed(1)}${p.l10Avg != null ? `, L10 avg ${p.l10Avg.toFixed(1)}` : ''} · *no live line, so no pick or EV (use live_props)*`
      : `**${p.label}** (${fmtAmerican(p.american)} @ ${p.book})\nproj ${p.proj.toFixed(1)} ${STAT_ABBR[p.stat]}${p.l10Avg != null ? ` (L10 avg ${p.l10Avg.toFixed(1)})` : ''} · hit ${probBar(p.p, 8)} ${pct(p.p, 0)} · EV ${evText(p.ev)}${p.questionable ? ' · ⚠️ injury listed' : ''}`).join('\n')) });
  }

  const wx = a.home?.weather || a.away?.weather;
  if (wx?.text) e.addFields({ name: '🌦️ Weather', value: `${wx.text}${wx.temp != null ? `, ${wx.temp}°F` : ''}`, inline: true });
  if (a.h2hAdj) e.addFields({ name: '🤝 H2H nudge', value: `${a.h2hAdj >= 0 ? '+' : ''}${a.h2hAdj.toFixed(2)} ${unit} to ${homeName}`, inline: true });
  return e;
}

function bestBetsEmbed(label, bets = [], nGames = 0, meta = {}) {
  const color = (bets && bets.length && bets[0].tier) ? bets[0].tier.color : 0x95a5a6;
  const e = base(color).setTitle(`💰 Best bets: ${label}`);
  e.setDescription(banner(meta) + `Scanned **${nGames}** game(s). Picks are logged: run /record to see how the bot is doing.\nRanked by **history-based hit probability** (team ratings, last 10, home/road splits, head-to-head, injuries). The market is only a sanity check.`);
  if (!bets || !bets.length) { 
    e.addFields({ name: 'No high-confidence picks', value: 'Nothing cleared the probability and agreement thresholds today. Passing is a valid play.' }); 
    return e; 
  }
  bets.forEach((b, i) => e.addFields({ name: `${i + 1}. ${b.tier?.emoji || '🟢'} ${b.label} (${fmtAmerican(b.american)} @ ${b.book})`, value: trim(
    `${probBar(b.p)} **${pct(b.p)}** hit probability · ${b.estimated ? 'est. line, confirm at your book' : `EV **${evText(b.ev)}**`}\n` +
    (b.type === 'PROP'
      ? `projection ${b.proj.toFixed(1)} vs line ${b.line} · season avg ${b.avg}${b.l10Avg != null ? ` · L10 avg ${b.l10Avg.toFixed(1)}` : ''}`
      : `model ${pct(b.pModel)} · market ${pct(b.pMkt)} · ¼-Kelly ${pct(b.kelly, 2)}${b.why ? `\n${b.why}` : ''}`)) }));
  return e;
}

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
function lineupEmbed(label, parlays = {}, legsN = 2, mode = 'game', meta = {}) {
  const e = base(0x3498db).setTitle(`🎰 ${legsN}-Leg Parlay Engine (${label.toUpperCase()} — ${mode.toUpperCase()})`);
  let d = banner(meta);

  if (!parlays.strong && !parlays.risky) {
    e.setDescription(d + 'Not enough qualifying legs on this slate matching your criteria. Try reducing leg count or checking back later.');
    return e;
  }

  e.setDescription(d + 'Quantitative model breakdown separating high-probability +EV legs from high-upside payout legs.');

  if (parlays.strong) {
    const lu = parlays.strong;
    const per10 = (lu.dec - 1) * 10;
    let desc = `**Combined Probability:** ${pct(lu.pInd, 2)}${Math.abs(lu.pAdj - lu.pInd) > 1e-6 ? ` (Correlated: **${pct(lu.pAdj, 2)}**)` : ''}\n` +
               `**Total Odds:** ${fmtAmerican(lu.american)} (${lu.dec.toFixed(2)}x) · $10 wins **$${per10.toFixed(2)}**\n` +
               `**Expected Value:** ${evText(lu.ev)} per $1\n\n**Legs:**\n` +
               lu.legs.map((l, i) => `${NUM[i]} **${l.label}** (${fmtAmerican(l.american)} @ ${l.book} — ${pct(l.p)} win rate)`).join('\n');
    e.addFields({ name: '🛡️ Option 1: Strong / Optimized Parlay (Balanced +EV)', value: trim(desc, 1024) });
  }

  if (parlays.risky) {
    const lu = parlays.risky;
    const per10 = (lu.dec - 1) * 10;
    let desc = `**Combined Probability:** ${pct(lu.pInd, 2)}${Math.abs(lu.pAdj - lu.pInd) > 1e-6 ? ` (Correlated: **${pct(lu.pAdj, 2)}**)` : ''}\n` +
               `**Total Odds:** ${fmtAmerican(lu.american)} (${lu.dec.toFixed(2)}x) · $10 wins **$${per10.toFixed(2)}**\n` +
               `**Expected Value:** ${evText(lu.ev)} per $1\n\n**Legs:**\n` +
               lu.legs.map((l, i) => `${NUM[i]} **${l.label}** (${fmtAmerican(l.american)} @ ${l.book} — ${pct(l.p)} win rate)`).join('\n');
    if (lu.legs.some(l => l.altEstimated)) desc += '\n\n*Alt-line odds are model-estimated, not sportsbook prices, so the EV above is not meaningful.*';
    e.addFields({ name: '🔥 Option 2: Risky / Lotto Parlay (Max Upside Payout)', value: trim(desc, 1024) });
  }

  return e;
}

const ICON = { win: '✅', loss: '❌', push: '➖', pending: '⏳', void: '🚫' };
const fmtGroup = g => Object.entries(g).map(([k, v]) => `${k} ${v.w}-${v.l} (${pct(v.w / (v.w + v.l), 0)})`).join(' · ') || 'n/a';

function calibrationNote(s) {
  if (s.n < 20) return `Need 20+ graded picks for a calibration read (have ${s.n}).`;
  const diff = s.hitRate - s.avgP;
  if (diff < -0.08) return `Overconfident: the bot averaged ${pct(s.avgP)} but actually hit ${pct(s.hitRate)}. Try lowering BEST_MODEL_WEIGHT or raising BEST_MIN_P.`;
  if (diff > 0.08) return `Underconfident: the bot averaged ${pct(s.avgP)} but actually hit ${pct(s.hitRate)}. The thresholds could be loosened.`;
  return `Well calibrated: predicted ${pct(s.avgP)}, actual ${pct(s.hitRate)} (within 8 pts).`;
}

function recordEmbed(title, s, picks = [], history = []) {
  const color = s.hitRate == null ? 0x95a5a6 : s.hitRate >= 0.55 ? 0x2ecc71 : 0xe67e22;
  const e = base(color).setTitle(`📊 ${title}`);
  if (!s.n && !s.pending) { e.setDescription('No tracked picks in this window yet. Run `/bestbets` and the bot will log what it recommends.'); return e; }
  const rec = `${s.w}-${s.l}${s.push ? `-${s.push}` : ''}`;
  e.setDescription(`**${rec}** · hit rate **${s.hitRate == null ? 'n/a' : pct(s.hitRate)}**` +
    (s.roi == null ? '' : ` · ${s.units >= 0 ? '+' : ''}${s.units.toFixed(2)}u at real prices (flat 1u, ${s.pricedN} bets, ROI ${evText(s.roi)})`) +
    `${s.pending ? `\n⏳ ${s.pending} pending` : ''}${s.voided ? ` · 🚫 ${s.voided} voided` : ''}`);
  if (s.n) {
    e.addFields({ name: 'Calibration', value: trim(`Model-driven p ${pct(s.avgP)}${s.avgPMkt != null ? ` · market p ${pct(s.avgPMkt)}` : ''} · actual ${pct(s.hitRate)}\n${calibrationNote(s)}`) });
    e.addFields({ name: 'By type', value: trim(fmtGroup(s.byType)), inline: true }, { name: 'By sport', value: trim(fmtGroup(s.bySport)), inline: true },
      { name: 'By confidence', value: trim(fmtGroup(s.byBucket)) });
  }
  if (picks.length) e.addFields({ name: `Picks (${picks.length})`, value: trim(picks.slice(-12).map(p =>
    `${ICON[p.result] || '⏳'} ${p.label} (${pct(p.p, 0)})${p.actual ? ` · ${p.actual}` : ''}`).join('\n')) });
  if (history.length > 1) e.addFields({ name: 'By day', value: trim(history.map(h => `${h.day}: ${h.w}-${h.l}${h.push ? `-${h.push}` : ''}${h.hitRate == null ? '' : ` (${pct(h.hitRate, 0)})`}${h.pending ? ` +${h.pending}⏳` : ''}`).join('\n')) });
  return e;
}

module.exports = { recordEmbed, analyzeEmbed, bestBetsEmbed, lineupEmbed, errorEmbed, onCooldown, replyWithError, probBar, pct };
