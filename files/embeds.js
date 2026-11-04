'use strict';
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { HARD_LIMIT_MESSAGE, ApiHardLimitError, usageSnapshot, cooldownRemaining } = require('../cache/cacheManager');
const { fmtAmerican, fmtLine, confidenceTier, MIN_EV, STAT_ABBR } = require('../services/analyticsEngine');

const NOTE = 'Educational analytics, not financial advice. 21+. Problem gambling? 1-800-GAMBLER';
const pct = (p, d = 1) => `${(p * 100).toFixed(d)}%`;
const probBar = (p, size = 10) => { const f = Math.round(Math.min(1, Math.max(0, p)) * size); return '▰'.repeat(f) + '▱'.repeat(size - f); };
const evText = ev => `${ev >= 0 ? '+' : ''}${(ev * 100).toFixed(1)}%`;
const unix = iso => Math.floor(Date.parse(iso) / 1000);
const mmss = s => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
const trim = (s, n = 1000) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

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

function analyzeEmbed(a, props, meta) {
  const best = [...a.bets].sort((x, y) => y.ev - x.ev)[0];
  const tier = best ? confidenceTier(best.ev, best.p) : confidenceTier(0, 0.5);
  const unit = a.sport === 'nhl' ? 'goals' : a.sport === 'mlb' ? 'runs' : 'pts';
  const e = base(tier.color).setTitle(`🏟️ ${a.game.away} @ ${a.game.home}`);
  const fav = a.projMargin >= 0 ? a.game.home : a.game.away;
  let desc = banner(meta) + `Starts <t:${unix(a.game.commence)}:F>\nModel projection: **${fav} by ${Math.abs(a.projMargin).toFixed(1)} ${unit}**`;
  if (!a.reliable) desc += '\n⚠️ Missing standings data for one team. Probabilities below are NOT reliable.';
  e.setDescription(desc);

  const ml = a.bets.filter(b => b.type === 'ML');
  if (ml.length) {
    const [h, w] = [ml.find(b => b.side === 'home'), ml.find(b => b.side === 'away')];
    e.addFields({ name: '📈 Win probability (blended)', value: trim(
      `**${a.game.home}** ${probBar(h.p)} ${pct(h.p)}\n**${a.game.away}** ${probBar(w.p)} ${pct(w.p)}\n` +
      `Home: model ${pct(h.pModel)} · market ${pct(h.pMkt)} · blend ${pct(h.p)}\n` +
      ml.map(b => `${b.team}: ${fmtAmerican(b.american)} @ ${b.book} → EV ${evText(b.ev)}`).join('\n')) });
  }
  const sp = a.bets.filter(b => b.type === 'SPREAD');
  if (sp.length) {
    const s = [...sp].sort((x, y) => y.ev - x.ev)[0];
    e.addFields({ name: '🎯 Spread recommendation', value: trim(
      `${s.ev >= MIN_EV ? '✅' : '➖'} **${s.label}** (${fmtAmerican(s.american)} @ ${s.book})\n` +
      `Cover ${probBar(s.p)} **${pct(s.p)}** (model ${pct(s.pModel)}, market ${pct(s.pMkt)})\n` +
      `EV ${evText(s.ev)} · ${s.ev >= MIN_EV ? `¼-Kelly ${pct(s.kelly, 2)} of bankroll` : 'no edge: pass'}`) });
  }
  e.addFields({ name: `${tier.emoji} Confidence: ${tier.label}`, value: best && best.ev >= MIN_EV
    ? `Best edge: **${best.label}** (${fmtAmerican(best.american)}) at ${evText(best.ev)} EV`
    : 'No bet clears the +1% EV threshold after blending with the market. **Pass.**' });

  for (const side of ['home', 'away']) {
    const t = a[side];
    const items = t.injuries.items.filter(i => i.weight >= 0.25).slice(0, 4);
    e.addFields({ name: `🩹 ${t.name} (rating ${t.rating.rating >= 0 ? '+' : ''}${t.rating.rating.toFixed(1)}, injuries −${t.injuries.penalty.toFixed(1)})`,
      value: items.length ? trim(items.map(injLine).join('\n')) : 'No significant injuries listed', inline: true });
  }
  if (props.length) {
    e.addFields({ name: '🏀 Player props (top 3)', value: trim(props.slice(0, 3).map(p =>
      `**${p.label}** ${p.estimated ? '*(est. line)*' : `(${fmtAmerican(p.american)} @ ${p.book})`}\n` +
      `proj ${p.proj.toFixed(1)} ${STAT_ABBR[p.stat]} · hit ${probBar(p.p, 8)} ${pct(p.p, 0)} · EV ${evText(p.ev)}${p.questionable ? ' · ⚠️ injury listed' : ''}`).join('\n')) });
  }
  const wx = a.home.weather || a.away.weather;
  if (wx?.text) e.addFields({ name: '🌦️ Weather', value: `${wx.text}${wx.temp != null ? `, ${wx.temp}°F` : ''}`, inline: true });
  if (a.h2hAdj) e.addFields({ name: '🤝 H2H nudge', value: `${a.h2hAdj >= 0 ? '+' : ''}${a.h2hAdj.toFixed(2)} ${unit} to ${a.game.home}`, inline: true });
  return e;
}

function bestBetsEmbed(label, bets, nGames, meta) {
  const color = bets.length ? bets[0].tier.color : 0x95a5a6;
  const e = base(color).setTitle(`💰 Best bets: ${label}`);
  e.setDescription(banner(meta) + `Scanned **${nGames}** game(s). Conservative mode: single bets, p ≥ 50%, price ≤ +130, ranked by EV and win probability.`);
  if (!bets.length) { e.addFields({ name: 'No +EV bets found', value: 'The market looks efficient against this model today. Passing is a valid play.' }); return e; }
  bets.forEach((b, i) => e.addFields({ name: `${i + 1}. ${b.tier.emoji} ${b.label} (${fmtAmerican(b.american)} @ ${b.book})`, value: trim(
    `${probBar(b.p)} **${pct(b.p)}** win/cover · EV **${evText(b.ev)}** · ${b.tier.label}\n` +
    `model ${pct(b.pModel)} · market ${pct(b.pMkt)} · ¼-Kelly ${pct(b.kelly, 2)}`) }));
  return e;
}

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
function lineupEmbed(label, lu, legsN, meta) {
  const e = base(0xe74c3c).setTitle(`🎰 ${legsN}-leg high-risk lineup: ${label}`);
  let d = banner(meta);
  if (!lu) { e.setDescription(d + 'Not enough qualifying legs on this slate (each game can supply one leg, or two if they are positively correlated). Try fewer legs or check back when more games are posted.'); return e; }
  e.setDescription(d + '⚠️ **High variance.** Most parlays lose. Shown to make the real math visible, not as a recommendation.');
  lu.legs.forEach((l, i) => e.addFields({ name: `${NUM[i]} ${l.label}${l.type === 'PROP' && l.estimated ? ' *(est. line)*' : ''}`, value:
    `${fmtAmerican(l.american)} @ ${l.book} · hit rate ${probBar(l.p, 8)} **${pct(l.p)}**` }));
  const per10 = (lu.dec - 1) * 10;
  e.addFields(
    { name: '🧮 Compound probability', value: `${lu.legs.map(l => pct(l.p, 0)).join(' × ')} = **${pct(lu.pInd, 2)}**` +
      (Math.abs(lu.pAdj - lu.pInd) > 1e-6 ? `\nCorrelation-adjusted (same-game legs): **${pct(lu.pAdj, 2)}**` : '') +
      `\nThat is about **1 in ${Math.round(1 / lu.pAdj)}**.` },
    { name: '💵 Payout', value: `**${fmtAmerican(lu.american)}** (${lu.dec.toFixed(2)}x) · $10 wins **$${per10.toFixed(2)}**\nBreak-even hit rate: ${pct(1 / lu.dec, 2)}` },
    { name: '📉 Parlay expected value', value: `**${evText(lu.ev)}** per $1 staked${lu.ev < 0 ? '\nNegative EV: bookmaker margin compounds with every leg.' : ''}` });
  return e;
}

module.exports = { analyzeEmbed, bestBetsEmbed, lineupEmbed, errorEmbed, onCooldown, replyWithError, probBar, pct };
