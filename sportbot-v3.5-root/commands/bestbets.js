'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { startCooldown } = require('../cache/cacheManager');

const oddsService = require('../services/oddsService');
const tracker = require('../services/tracker');

const { analyzeGame, buildProps, pickBestBets, pickBestBetsClassic, buildSlip } = require('../services/analyticsEngine');
const { bestBetsEmbed, errorEmbed, onCooldown, replyWithError } = require('./embeds');

const SPORT_CHOICES = Array.isArray(oddsService?.SPORT_CHOICES) && oddsService.SPORT_CHOICES.length > 0
  ? oddsService.SPORT_CHOICES
  : [
      { name: 'NBA', value: 'nba' },
      { name: 'NFL', value: 'nfl' },
      { name: 'NHL', value: 'nhl' },
      { name: 'MLB', value: 'mlb' },
      { name: 'Premier League', value: 'epl' },
      { name: 'MLS', value: 'mls' },
      { name: 'UEFA Champions League', value: 'uefa' },
      { name: 'La Liga', value: 'laliga' },
    ];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bestbets')
    .setDescription("Scan today's slate for the top +EV single picks")
    .addStringOption(o => o.setName('sport').setDescription('League').setRequired(true).addChoices(...SPORT_CHOICES))
    .addStringOption(o => o.setName('mode').setDescription('Pick engine (default: classic)')
      .addChoices({ name: 'Classic (original model, market-anchored)', value: 'classic' }, { name: 'History (last-10, splits, H2H, alt-line props)', value: 'history' })),

  async execute(interaction) {
    if (await onCooldown(interaction)) return;
    await interaction.deferReply();
    try {
      const sport = interaction.options.getString('sport', true);
      
      const getSlate = oddsService?.getSlate;
      const getAnalysisContext = oddsService?.getAnalysisContext;
      const SPORTS = oddsService?.SPORTS || {};

      if (typeof getSlate !== 'function') {
        throw new Error(`oddsService.getSlate is ${typeof getSlate}. Check your console logs above for the underlying error in oddsService.js.`);
      }
      
      const slate = await getSlate(sport);
      if (!slate || !slate.games || !slate.games.length) {
        const sportLabel = SPORTS[sport]?.label || sport.toUpperCase();
        const windowHours = SPORTS[sport]?.windowHours || 36;
        return void await interaction.editReply({ embeds: [errorEmbed(`No ${sportLabel} games`,
          `Nothing on the odds board in the next ${windowHours}h (off-day or off-season).`)] });
      }
      
      const ctx = typeof getAnalysisContext === 'function' ? await getAnalysisContext(sport, { games: slate.games, withLogs: sport === 'nba' }) : {};
      
      // Games without standings data are marked unreliable by the engine and skipped by pickBestBets.
      const mode = interaction.options.getString('mode') || process.env.BEST_MODE || 'classic';
      const analyses = slate.games.map(g => analyzeGame(sport, g, ctx, null, { classic: mode === 'classic' }));
      const props = sport === 'nba' && mode !== 'classic' ? analyses.filter(a => a.reliable).flatMap(a => buildProps(a, ctx, null)) : [];
      const bets = (mode === 'classic' ? pickBestBetsClassic(analyses, 5) : pickBestBets(analyses, 5, props)).map(b => ({ ...b, mode }));   // ranked by hit probability; an empty list is a valid answer

      try { tracker.logPicks(sport, bets); } catch (e) { console.error('[tracker] log failed:', e.message); }
      const meta = { mode, slip: buildSlip(bets), stale: slate.stale || ctx.stale, blocked: slate.blocked || ctx.blocked, missing: ctx.missing };
      const sportLabel = SPORTS[sport]?.label || sport.toUpperCase();
      
      await interaction.editReply({ embeds: [bestBetsEmbed(sportLabel, bets, slate.games.length, meta)] });
      startCooldown(interaction.user.id);
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
