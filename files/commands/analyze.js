'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { startCooldown, HARD_LIMIT_MESSAGE } = require('../cache/cacheManager');
const oddsService = require('../services/oddsService');
const { analyzeGame, buildProps } = require('../services/analyticsEngine');
const { analyzeEmbed, errorEmbed, onCooldown, replyWithError } = require('./embeds');

// Extract properties safely with fallback to prevent circular-import crashes at registration time
const SPORTS = oddsService.SPORTS || {};
const getSlate = oddsService.getSlate;
const findGame = oddsService.findGame;
const getAnalysisContext = oddsService.getAnalysisContext;
const getH2HMargin = oddsService.getH2HMargin;
const getLiveProps = oddsService.getLiveProps;

// Safe dynamic resolution for SPORT_CHOICES
const SPORT_CHOICES = Array.isArray(oddsService.SPORT_CHOICES) && oddsService.SPORT_CHOICES.length > 0
  ? oddsService.SPORT_CHOICES
  : [
      { name: 'NBA', value: 'nba' },
      { name: 'NFL', value: 'nfl' },
      { name: 'NHL', value: 'nhl' },
      { name: 'MLB', value: 'mlb' },
      { name: 'Premier League', value: 'epl' },
      { name: 'MLS', value: 'mls' },
    ];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Quantitative breakdown of one matchup: win %, spread, injuries, props')
    .addStringOption(o => o.setName('sport').setDescription('League').setRequired(true).addChoices(...SPORT_CHOICES))
    .addStringOption(o => o.setName('team_a').setDescription('First team (e.g. Celtics)').setRequired(true))
    .addStringOption(o => o.setName('team_b').setDescription('Opponent (e.g. Heat)').setRequired(true))
    .addBooleanOption(o => o.setName('live_props').setDescription('Pull real sportsbook prop lines (costs 3 API credits)')),

  async execute(interaction) {
    if (await onCooldown(interaction)) return;
    await interaction.deferReply();
    try {
      const sport = interaction.options.getString('sport', true);
      const teamA = interaction.options.getString('team_a', true);
      const teamB = interaction.options.getString('team_b', true);
      const wantLive = interaction.options.getBoolean('live_props') === true;

      const slate = await getSlate(sport);
      const game = findGame(slate.games, teamA, teamB);
      if (!game) {
        return void await interaction.editReply({ embeds: [errorEmbed('No matching game',
          `No ${SPORTS[sport]?.label || sport.toUpperCase()} game between **${teamA}** and **${teamB}** in the next ${SPORTS[sport]?.windowHours || 36}h odds window. ` +
          'Check spelling (nicknames work, e.g. "Celtics") or try `/bestbets` to see what is scheduled.')] });
      }

      const ctx = await getAnalysisContext(sport);
      const h2h = await getH2HMargin(game.home, game.away);
      const analysis = analyzeGame(sport, game, ctx, h2h.margin);

      let live = null, liveNote = null;
      if (wantLive && sport === 'nba') {
        live = await getLiveProps(sport, game);
        if (!live.props) liveNote = live.blocked ? HARD_LIMIT_MESSAGE : 'Live prop lines unavailable; using estimated lines.';
      }
      const props = buildProps(analysis, ctx, live?.props);

      const meta = { stale: slate.stale || ctx.stale || h2h.stale, blocked: slate.blocked || ctx.blocked || h2h.blocked || (live?.blocked ?? false), missing: ctx.missing };
      const embed = analyzeEmbed(analysis, props, meta);
      if (liveNote) embed.setDescription(`${embed.data.description}\nℹ️ ${liveNote}`);
      await interaction.editReply({ embeds: [embed] });
      startCooldown(interaction.user.id);
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
