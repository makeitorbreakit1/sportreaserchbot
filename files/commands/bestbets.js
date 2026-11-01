'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { startCooldown } = require('../cache/cacheManager');
const { SPORTS, SPORT_CHOICES, getSlate, getAnalysisContext } = require('../services/oddsService');
const { analyzeGame, pickBestBets } = require('../services/analyticsEngine');
const { bestBetsEmbed, errorEmbed, onCooldown, replyWithError } = require('./embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bestbets')
    .setDescription("Scan today's slate for the top +EV single picks")
    .addStringOption(o => o.setName('sport').setDescription('League').setRequired(true).addChoices(...SPORT_CHOICES)),

  async execute(interaction) {
    if (await onCooldown(interaction)) return;
    await interaction.deferReply();
    try {
      const sport = interaction.options.getString('sport', true);
      const slate = await getSlate(sport);
      if (!slate.games.length) {
        return void await interaction.editReply({ embeds: [errorEmbed(`No ${SPORTS[sport].label} games`,
          `Nothing on the odds board in the next ${SPORTS[sport].windowHours}h (off-day or off-season).`)] });
      }
      const ctx = await getAnalysisContext(sport);
      const analyses = slate.games.map(g => analyzeGame(sport, g, ctx));
      const bets = pickBestBets(analyses, 5);
      const meta = { stale: slate.stale || ctx.stale, blocked: slate.blocked || ctx.blocked, missing: ctx.missing };
      await interaction.editReply({ embeds: [bestBetsEmbed(SPORTS[sport].label, bets, slate.games.length, meta)] });
      startCooldown(interaction.user.id);
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
