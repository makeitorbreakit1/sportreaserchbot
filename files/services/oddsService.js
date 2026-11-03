'use strict';

// Define your sports configuration object with exact Odds API keys
const SPORTS = {
  nba: { label: 'NBA', key: 'basketball_nba', windowHours: 36 },
  nfl: { label: 'NFL', key: 'americanfootball_nfl', windowHours: 72 },
  nhl: { label: 'NHL', key: 'icehockey_nhl', windowHours: 36 },
  mlb: { label: 'MLB', key: 'baseball_mlb', windowHours: 36 },
  epl: { label: 'Premier League', key: 'soccer_epl', windowHours: 72 },
  mls: { label: 'MLS', key: 'soccer_usa_mls', windowHours: 72 },
  uefa: { label: 'UEFA Champions League', key: 'soccer_uefa_champs_league', windowHours: 72 },
};

const SPORT_CHOICES = [
  { name: 'NBA', value: 'nba' },
  { name: 'NFL', value: 'nfl' },
  { name: 'NHL', value: 'nhl' },
  { name: 'MLB', value: 'mlb' },
  { name: 'Premier League', value: 'epl' },
  { name: 'MLS', value: 'mls' },
  { name: 'UEFA', value: 'uefa' },
];

async function getSlate(sport) {
  const cfg = SPORTS[sport] || { key: sport, windowHours: 72 };
  const apiKey = process.env.ODDS_API_KEY;

  if (!apiKey) {
    console.error('[ODDS_SERVICE] Missing ODDS_API_KEY in environment variables.');
    return { games: [], stale: false, blocked: true, missing: ['API_KEY'] };
  }

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${cfg.key}/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`[ODDS_SERVICE] API error for ${sport}: ${response.status} ${response.statusText}`);
      return { games: [], stale: true, blocked: false, missing: [sport] };
    }

    const rawGames = await response.json();
    if (!Array.isArray(rawGames) || rawGames.length === 0) {
      return { games: [], stale: false, blocked: false, missing: [] };
    }

    // Map response games to internal format
    const games = rawGames.map(g => {
      const h2hMarket = g.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h');
      const spreadMarket = g.bookmakers?.[0]?.markets?.find(m => m.key === 'spreads');
      const totalMarket = g.bookmakers?.[0]?.markets?.find(m => m.key === 'totals');

      const homeOutcome = h2hMarket?.outcomes?.find(o => o.name === g.home_team);
      const awayOutcome = h2hMarket?.outcomes?.find(o => o.name === g.away_team);

      return {
        id: g.id,
        home: g.home_team,
        away: g.away_team,
        commenceTime: g.commence_time,
        ml: homeOutcome && awayOutcome ? {
          home: { american: homeOutcome.price, dec: homeOutcome.price > 0 ? 1 + homeOutcome.price/100 : 1 + 100/Math.abs(homeOutcome.price), book: g.bookmakers[0].title },
          away: { american: awayOutcome.price, dec: awayOutcome.price > 0 ? 1 + awayOutcome.price/100 : 1 + 100/Math.abs(awayOutcome.price), book: g.bookmakers[0].title },
          fairHome: 0.5,
          fairAway: 0.5
        } : null,
        spread: spreadMarket ? { point: spreadMarket.outcomes[0]?.point, home: spreadMarket.outcomes[0], away: spreadMarket.outcomes[1] } : null,
        total: totalMarket ? { point: totalMarket.outcomes[0]?.point, over: totalMarket.outcomes.find(o => o.name === 'Over'), under: totalMarket.outcomes.find(o => o.name === 'Under') } : null
      };
    });

    return { games, stale: false, blocked: false, missing: [] };
  } catch (err) {
    console.error(`[ODDS_SERVICE] Failed to fetch slate for ${sport}:`, err);
    return { games: [], stale: true, blocked: false, missing: [sport] };
  }
}

async function getAnalysisContext(sport) {
  return { stale: false, blocked: false, missing: [] };
}

async function getH2HMargin(home, away) {
  return { margin: 0 };
}

async function getLiveProps(sport, game) {
  return { props: [] };
}

async function findGame() {
  return null;
}

async function findKey() {
  return null;
}

function processOddsServiceLogic(analyses, propsByGame, legsN, mode = 'game') {
  const strongCands = [];
  const demonCands = [];

  for (const a of analyses) {
    if (!a.reliable) continue;

    if (mode === 'game' || mode === 'both') {
      for (const b of a.bets) {
        if (b.type === 'ML' && b.p >= 0.3 && b.p <= 0.6) strongCands.push(b);
        if (b.type === 'SPREAD' && b.p >= 0.46) {
          strongCands.push(b);
          const altSpreadLine = b.line != null ? b.line + (b.line > 0 ? 3.0 : -3.0) : null;
          if (altSpreadLine != null) {
            const altP = Math.max(0.15, Math.min(0.45, b.p - 0.15));
            const altDec = Math.round((1 / (altP * 0.88)) * 100) / 100;
            demonCands.push({
              ...b,
              line: altSpreadLine,
              p: altP,
              dec: altDec,
              label: `${b.team} ${altSpreadLine} (🔥 DEMON SPREAD)`
            });
          }
        }
        if (b.type === 'TOTAL' && b.p >= 0.5) {
          strongCands.push(b);
          const altTotalLine = b.line != null ? b.line + (b.side === 'over' ? 2.5 : -2.5) : null;
          if (altTotalLine != null) {
            const altP = Math.max(0.15, Math.min(0.45, b.p - 0.12));
            const altDec = Math.round((1 / (altP * 0.88)) * 100) / 100;
            demonCands.push({
              ...b,
              line: altTotalLine,
              p: altP,
              dec: altDec,
              label: `${b.side.toUpperCase()} ${altTotalLine} (🔥 DEMON TOTAL)`
            });
          }
        }
      }
    }
  }

  return { strongCands, demonCands };
}

module.exports = {
  SPORTS,
  SPORT_CHOICES,
  getSlate,
  getAnalysisContext,
  getH2HMargin,
  getLiveProps,
  findGame,
  findKey,
  processOddsServiceLogic
};
