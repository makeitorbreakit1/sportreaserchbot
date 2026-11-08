'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { startCooldown, HARD_LIMIT_MESSAGE, ApiHardLimitError } = require('../cache/cacheManager');

const oddsService = require('../services/oddsService');
const tracker = require('../services/tracker');
const kalshi = require('../services/kalshiService');

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
      .addChoices({ name: 'Classic (original model, market-anchored)', value: 'classic' }, { name: 'History (last-10, splits, H2H, real-line props)', value: 'history' }))
    .addBooleanOption(o => o.setName('live_props').setDescription('NBA history mode: pull real sportsbook prop lines for the next few games (3 API credits each)')),

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
      // Player props are only ever picks when a real market posted a line AND a price for both sides:
      //   • Kalshi public API (FREE, no credits)       — always tried for NBA in history mode
      //   • Odds API sportsbook props (3 credits/game) — only with live_props:true
      // Without either, the bot makes no player picks (it never invents a line).
      const wantLive = interaction.options.getBoolean('live_props') === true;
      const propsNotes = [];
      const liveByGame = {};
      let kalshiProps = null;
      if (sport === 'nba' && mode !== 'classic') {
        const k = await kalshi.getKalshiProps('nba');
        kalshiProps = k.props;
        if (!kalshiProps && k.note) propsNotes.push(k.note);
        if (wantLive && typeof oddsService.getLiveProps === 'function') {
          const maxGames = Math.max(1, Number(process.env.PROP_GAMES_MAX) || 3);
          const targets = analyses.filter(a => a.reliable).sort((x, y) => Date.parse(x.game.commenceTime) - Date.parse(y.game.commenceTime)).slice(0, maxGames);
          for (const a of targets) {
            try {
              const r = await oddsService.getLiveProps(sport, a.game);
              if (r?.props) liveByGame[a.game.id] = r.props;
              else if (r?.blocked) { propsNotes.push(HARD_LIMIT_MESSAGE); break; }
            } catch (e) {
              if (e instanceof ApiHardLimitError) { propsNotes.push(HARD_LIMIT_MESSAGE); break; }
              propsNotes.push(`Sportsbook prop lines unavailable for ${a.game.away} @ ${a.game.home}.`);
            }
          }
        }
        if (kalshiProps) propsNotes.unshift(`Prop lines: Kalshi (free)${Object.keys(liveByGame).length ? ' + sportsbooks' : ''}. Kalshi prices include an estimated fee.`);
        else if (!Object.keys(liveByGame).length) propsNotes.push('Player props skipped: no real market lines available. Re-run with `live_props:true` for sportsbook lines (3 credits per game).');
      }
      const propsFor = a => kalshi.mergeProps(liveByGame[a.game.id] || null, kalshiProps);
      const props = sport === 'nba' && mode !== 'classic'
        ? analyses.filter(a => a.reliable && propsFor(a)).flatMap(a => buildProps(a, ctx, propsFor(a))) : [];
      const bets = (mode === 'classic' ? pickBestBetsClassic(analyses, 5) : pickBestBets(analyses, 5, props)).map(b => ({ ...b, mode }));   // ranked by hit probability; an empty list is a valid answer

      try { tracker.logPicks(sport, bets); } catch (e) { console.error('[tracker] log failed:', e.message); }
      const meta = { mode, slip: buildSlip(bets), stale: slate.stale || ctx.stale, blocked: slate.blocked || ctx.blocked, missing: ctx.missing, propsNote: propsNotes.join(' ') };
      const sportLabel = SPORTS[sport]?.label || sport.toUpperCase();
      
      await interaction.editReply({ embeds: [bestBetsEmbed(sportLabel, bets, slate.games.length, meta)] });
      startCooldown(interaction.user.id);
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
