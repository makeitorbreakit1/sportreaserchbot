function buildDualParlays(analyses, propsByGame, legsN, mode = 'game') {
  const strongCands = [];
  const demonCands = [];

  for (const a of analyses) {
    if (!a.reliable) continue;

    // 1. Game Lines (ML, Spreads, Totals) — Supporting both Strong & Demon Alts for ALL sports
    if (mode === 'game' || mode === 'both') {
      for (const b of a.bets) {
        if (b.type === 'ML' && b.p >= 0.3 && b.p <= 0.6) strongCands.push(b);
        if (b.type === 'SPREAD' && b.p >= 0.46) {
          strongCands.push(b);
          // Synthesize Demon Alt Spread (harder cover line for higher odds)
          const altSpreadLine = b.line != null ? b.line + (b.line > 0 ? 3.0 : -3.0) : null;
          if (altSpreadLine != null) {
            const altP = clamp(b.p - 0.15, 0.15, 0.45);
            const altDec = Math.round((1 / (altP * 0.88)) * 100) / 100;
            demonCands.push({
              ...b,
              line: altSpreadLine,
              p: altP,
              dec: altDec,
              american: decimalToAmerican(altDec),
              label: `${b.team} ${fmtLine(altSpreadLine)} (🔥 DEMON SPREAD)`
            });
          }
        }
        if (b.type === 'TOTAL' && b.p >= 0.5) {
          strongCands.push(b);
          // Synthesize Demon Alt Total
          const altTotalLine = b.line != null ? b.line + (b.side === 'over' ? 2.5 : -2.5) : null;
          if (altTotalLine != null) {
            const altP = clamp(b.p - 0.12, 0.15, 0.45);
            const altDec = Math.round((1 / (altP * 0.88)) * 100) / 100;
            demonCands.push({
              ...b,
              line: altTotalLine,
              p: altP,
              dec: altDec,
              american: decimalToAmerican(altDec),
              label: `${b.side.toUpperCase()} ${altTotalLine} (🔥 DEMON TOTAL)`
            });
          }
        }
      }
    }

    // 2. Player Props (NBA / Supported leagues)
    if (mode === 'player' || mode === 'both') {
      for (const pr of propsByGame[a.game.id] || []) {
        if (pr.p >= 0.40 && !pr.questionable) {
          // Standard prop candidate for Option 1
          strongCands.push(pr);

          // PURE DEMON ALT PROP FOR OPTION 2 ONLY
          const bump = pr.stat === 'points' ? 3.5 : 2.0;
          const altLine = pr.line + bump;
          const altP = 1 - normCdf((altLine - pr.proj) / pr.sd);

          if (altP >= 0.15 && altP <= 0.45) {
            const altDec = Math.round((1 / (altP * 0.90)) * 100) / 100;
            demonCands.push({
              ...pr,
              line: altLine,
              p: altP,
              dec: altDec,
              american: decimalToAmerican(altDec),
              label: `${pr.player} Over ${altLine} ${STAT_ABBR[pr.stat] || ''} (🔥 DEMON ALT) [${Math.round(altP * 100)}% Win Rate]`
            });
          }
        }
      }
    }
  }

  if (strongCands.length < legsN) return { strong: null, risky: null };

  const sortedStrongCands = [...strongCands].sort((a, b) => (b.ev * 2 + b.p) - (a.ev * 2 + a.p));

  // 1. Option 1 (Strong Parlay): Built strictly from standard, high-probability baseline picks
  let bestStrong = null;
  for (const combo of combinations(sortedStrongCands, legsN)) {
    const r = evalCombo(combo);
    if (!r) continue;
    const strongScore = r.ev * 2 + r.pAdj;
    if (!bestStrong || strongScore > (bestStrong.ev * 2 + bestStrong.pAdj)) {
      bestStrong = r;
    }
  }

  if (!bestStrong) return { strong: null, risky: null };

  // 2. Option 2 (Risky / Lotto Parlay): Built EXCLUSIVELY from the 🔥 DEMON ALT lines
  let bestRisky = null;
  const sortedDemonCands = [...demonCands].sort((a, b) => b.dec - a.dec);

  if (sortedDemonCands.length >= legsN) {
    for (const combo of combinations(sortedDemonCands, legsN)) {
      const r = evalCombo(combo);
      if (!r) continue;
      if (!bestRisky || r.dec > bestRisky.dec) {
        bestRisky = r;
      }
    }
  }

  // Fallback if demon pool needs extra legs
  if (!bestRisky) {
    const fallbackPool = [...sortedStrongCands].reverse();
    bestRisky = evalCombo(fallbackPool.slice(0, legsN));
  }

  return { strong: bestStrong, risky: bestRisky };
}
