'use strict';
// Run:  npm run kalshi:probe     (needs internet; uses Kalshi's free public API, no key)
// Prints what the bot discovers on Kalshi so the matcher can be checked against the real data.
require('dotenv').config();
const K = require('../services/kalshiService');

(async () => {
  const series = await K.discoverSeries('nba');
  console.log(`NBA prop series matched (${series.length}):`, series.join(', ') || '(none)');
  if (!series.length) {
    console.log('\nNo series matched. List Sports series yourself and send me the output:');
    console.log('  curl -s "https://api.elections.kalshi.com/trade-api/v2/series?category=Sports" | head -c 4000');
    return;
  }
  const raw = [];
  for (const t of series.slice(0, 6)) { const m = await K.openMarkets(t); console.log(`  ${t}: ${m.length} open market(s)`); raw.push(...m); }
  console.log('\nSample raw market (field names as Kalshi returns them):');
  console.log(JSON.stringify(raw[0] || null, null, 2));
  const { props, stats } = K.buildPropMap(raw);
  console.log('\nParse stats:', JSON.stringify(stats));
  for (const stat of Object.keys(props)) {
    for (const [name, v] of Object.entries(props[stat]).slice(0, 8)) {
      console.log(`  ${stat.padEnd(8)} ${name.padEnd(24)} over ${v.point}  Over ${v.over.american}  Under ${v.under.american}  (${v.ticker})`);
    }
  }
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
