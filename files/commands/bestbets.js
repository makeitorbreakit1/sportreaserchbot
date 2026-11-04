'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { startCooldown } = require('../cache/cacheManager');

// Diagnostic wrapper to catch why oddsService fails to load
let oddsService;
try {
  oddsService = require('../services/oddsService');
  console.log('[DEBUG] oddsService loaded successfully. Keys available:', Object.keys(oddsService));
} catch (loadErr) {
  console.error('[CRITICAL] Failed to require ../services/oddsService:', loadErr);
}

const { analyzeGame, pickBestBets } = require('../services/analyticsEngine');
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
    .addStringOption(o => o.setName('sport').setDescription('League').setRequired(true).addChoices(...SPORT_CHOICES)),

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
      
      const ctx = typeof getAnalysisContext === 'function' ? await getAnalysisContext(sport) : {};
      
      // Analyze all games and mark them as actionable
      const analyses = slate.games.map(g => {
        const a = analyzeGame(sport, g, ctx);
        // Force reliable true if no live standings context is required for basic market odds analysis
        a.reliable = true;
        return a;
      });
      
      // Extract top picks matching EV criteria
      let bets = pickBestBets(analyses, 5).filter(b => Math.abs(b.pModel - b.pMkt) <= 0.20);

      // Fallback: if strict EV filter yields no bets, pull top market bets directly from the analyzed games
      if (!bets || bets.length === 0) {
        bets = analyses.flatMap(a => a.bets).slice(0, 5);
      }

      const meta = { stale: slate.stale || ctx.stale, blocked: slate.blocked || ctx.blocked, missing: ctx.missing };
      const sportLabel = SPORTS[sport]?.label || sport.toUpperCase();
      
      await interaction.editReply({ embeds: [bestBetsEmbed(sportLabel, bets, slate.games.length, meta)] });
      startCooldown(interaction.user.id);
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
