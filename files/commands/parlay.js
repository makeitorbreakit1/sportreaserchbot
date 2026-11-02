'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { startCooldown } = require('../cache/cacheManager');
const { SPORTS, SPORT_CHOICES, getSlate, getAnalysisContext } = require('../services/oddsService');
const { analyzeGame, buildProps, buildLineup } = require('../services/analyticsEngine');
const { lineupEmbed, errorEmbed, onCooldown, replyWithError } = require('./embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lineup')
    .setDescription('High-risk multi-leg lineup with true compound probability')
    .addStringOption(o => o.setName('sport').setDescription('League').setRequired(true).addChoices(...SPORT_CHOICES))
    .addIntegerOption(o => o.setName('legs').setDescription('Number of legs (3-5)').setRequired(true).setMinValue(3).setMaxValue(5)),

  async execute(interaction) {
    if (await onCooldown(interaction)) return;
    await interaction.deferReply();
    try {
      const sport = interaction.options.getString('sport', true);
      const legs = interaction.options.getInteger('legs', true);
      const slate = await getSlate(sport);
      if (!slate.games.length) {
        return void await interaction.editReply({ embeds: [errorEmbed(`No ${SPORTS[sport].label} games`,
          `Nothing on the odds board in the next ${SPORTS[sport].windowHours}h.`)] });
      }
      const ctx = await getAnalysisContext(sport);
      const analyses = slate.games.map(g => analyzeGame(sport, g, ctx));
      const propsByGame = {};
      analyses.forEach(a => { propsByGame[a.game.id] = buildProps(a, ctx, null); }); // estimated lines: zero extra credits
      const lineup = buildLineup(analyses, propsByGame, legs);
      const meta = { stale: slate.stale || ctx.stale, blocked: slate.blocked || ctx.blocked, missing: ctx.missing };
      await interaction.editReply({ embeds: [lineupEmbed(SPORTS[sport].label, lineup, legs, meta)] });
      startCooldown(interaction.user.id);
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
