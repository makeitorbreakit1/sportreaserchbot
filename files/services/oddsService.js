'use strict';

// Define your sports configuration object
const SPORTS = {
  nba: { label: 'NBA', windowHours: 36 },
  nfl: { label: 'NFL', windowHours: 72 },
  nhl: { label: 'NHL', windowHours: 36 },
  mlb: { label: 'MLB', windowHours: 36 },
  epl: { label: 'Premier League', windowHours: 48 },
  mls: { label: 'MLS', windowHours: 48 },
};

const SPORT_CHOICES = [
  { name: 'NBA', value: 'nba' },
  { name: 'NFL', value: 'nfl' },
  { name: 'NHL', value: 'nhl' },
  { name: 'MLB', value: 'mlb' },
  { name: 'Premier League', value: 'epl' },
  { name: 'MLS', value: 'mls' },
];

async function getSlate(sport) {
  // Add your slate fetching logic here
  return { games: [], stale: false, blocked: false, missing: [] };
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

// If you have custom odds service logic that processes bets/markets, put it here:
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

// CRITICAL: This ensures module.exports is never empty and exposes everything cleanly
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
