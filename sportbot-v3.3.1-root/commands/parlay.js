'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { startCooldown } = require('../cache/cacheManager');
const oddsService = require('../services/oddsService');
const { analyzeGame, buildProps, buildDualParlays } = require('../services/analyticsEngine');
const { lineupEmbed, errorEmbed, onCooldown, replyWithError } = require('./embeds');

// Safe dynamic resolution for SPORT_CHOICES to prevent startup crashes
const SPORT_CHOICES = Array.isArray(oddsService.SPORT_CHOICES) && oddsService.SPORT_CHOICES.length > 0
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

const SPORTS = oddsService.SPORTS || {};
const getSlate = oddsService.getSlate;
const getAnalysisContext = oddsService.getAnalysisContext;
const getH2HMargin = oddsService.getH2HMargin;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('parlay')
    .setDescription('Generate optimized multi-leg parlays (Strong vs. Risky)')
    .addStringOption(o => o.setName('sport').setDescription('League').setRequired(true).addChoices(...SPORT_CHOICES))
    .addIntegerOption(o => o.setName('legs').setDescription('Number of legs (3 to 5)').setRequired(true).setMinValue(3).setMaxValue(5))
    .addStringOption(o => o.setName('type').setDescription('Bet market category').setRequired(false)
      .addChoices(
        { name: 'Game Lines (Spreads/Totals/ML)', value: 'game' },
        { name: 'Player Props (Points/Rebounds/Assists)', value: 'player' },
        { name: 'Mixed (Game lines + Player props)', value: 'both' }
      )),

  async execute(interaction) {
    if (await onCooldown(interaction)) return;
    await interaction.deferReply();
    try {
      const sport = interaction.options.getString('sport', true);
      const legsN = interaction.options.getInteger('legs', true);
      const mode = interaction.options.getString('type') || 'game';

      const slate = await getSlate(sport);
      if (!slate || !slate.games || !slate.games.length) {
        const sportLabel = SPORTS[sport]?.label || sport.toUpperCase();
        return void await interaction.editReply({ 
          embeds: [errorEmbed('No games found', `No active ${sportLabel} games available for parlay calculation right now.`)] 
        });
      }

      const ctx = await getAnalysisContext(sport, { games: slate.games });
      const analyses = [];
      const propsByGame = {};

      for (const game of slate.games) {
        // Safe fallback if H2H lookup fails or times out
        const h2h = await getH2HMargin(game.home, game.away).catch(() => ({ margin: 0 }));
        const analysis = analyzeGame(sport, game, ctx, h2h.margin);
        
        analyses.push(analysis);

        // Estimated lines only (excluded from parlays as non-bettable): live prop lookups cost 3 credits PER GAME and would blow the daily cap.
        if (sport === 'nba') propsByGame[game.id] = buildProps(analysis, ctx, null);
      }

      const parlays = buildDualParlays(analyses, propsByGame, legsN, mode);
      
      // Guard against null/empty parlays
      if (!parlays || (!parlays.strong && !parlays.risky)) {
        return void await interaction.editReply({ 
          embeds: [errorEmbed('Not Enough Matching Legs', `Could not find enough valid ${mode} legs for a ${legsN}-leg parlay right now. Try fewer legs or 'Game Lines'. Player-prop legs need real sportsbook lines, which this command does not pull (use /analyze with live_props).`)] 
        });
      }

      const meta = { stale: slate.stale || ctx.stale, blocked: slate.blocked || ctx.blocked, missing: ctx.missing };
      const sportLabel = SPORTS[sport]?.label || sport.toUpperCase();
      const embed = lineupEmbed(sportLabel, parlays, legsN, mode, meta);

      await interaction.editReply({ embeds: [embed] });
      startCooldown(interaction.user.id);
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
