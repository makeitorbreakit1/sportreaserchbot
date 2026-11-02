'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { startCooldown } = require('../cache/cacheManager');
const { SPORTS, SPORT_CHOICES, getSlate, getAnalysisContext, getH2HMargin, getLiveProps } = require('../services/oddsService');
const { analyzeGame, buildProps, buildDualParlays } = require('../services/analyticsEngine');
const { lineupEmbed, errorEmbed, onCooldown, replyWithError } = require('./embeds');

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
      if (!slate.games || !slate.games.length) {
        return void await interaction.editReply({ 
          embeds: [errorEmbed('No games found', `No active ${SPORTS[sport]?.label || sport} games available for parlay calculation right now.`)] 
        });
      }

      const ctx = await getAnalysisContext(sport);
      const analyses = [];
      const propsByGame = {};

      for (const game of slate.games) {
        // Safe fallback if H2H lookup fails or times out
        const h2h = await getH2HMargin(game.home, game.away).catch(() => ({ margin: 0 }));
        const analysis = analyzeGame(sport, game, ctx, h2h.margin);
        analyses.push(analysis);

        if (sport === 'nba') {
          const live = await getLiveProps(sport, game).catch(() => null);
          const props = buildProps(analysis, ctx, live?.props);
          propsByGame[game.id] = props;
        }
      }

      const parlays = buildDualParlays(analyses, propsByGame, legsN, mode);
      
      // Guard against null/empty parlays
      if (!parlays || !parlays.strong) {
        return void await interaction.editReply({ 
          embeds: [errorEmbed('Not Enough Matching Legs', `Could not find enough valid ${mode} legs for a ${legsN}-leg parlay right now. Try lowering the legs count or selecting 'both'.`)] 
        });
      }

      const meta = { stale: slate.stale || ctx.stale, blocked: slate.blocked || ctx.blocked, missing: ctx.missing };
      const embed = lineupEmbed(SPORTS[sport].label, parlays, legsN, mode, meta);

      await interaction.editReply({ embeds: [embed] });
      startCooldown(interaction.user.id);
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
