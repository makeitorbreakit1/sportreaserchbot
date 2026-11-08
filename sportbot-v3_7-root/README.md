# Sports Quant Discord Bot

Slash-command bot (`/analyze`, `/bestbets`, `/parlay`) that runs a transparent quantitative model on **free API tiers** with a **hard-coded quota stop**.

## Project layout
```
index.js                     bot startup, command registration, routing, reconnect/shutdown
cache/cacheManager.js        TTL cache, HARD API caps, guardedFetch (only fetch() in the project), cooldowns
services/oddsService.js      Odds API + ESPN public feeds + TheSportsDB, credit-preserving
services/kalshiService.js    Kalshi free public market-data API (NBA player-prop lines, no key, read-only)
services/analyticsEngine.js  ratings, injury model, win/cover probability, EV, props, parlay math
commands/                    analyze.js, bestbets.js, parlay.js, embeds.js
test/                        `npm test`: math + mocked end-to-end tests (no network, no credits)
```

## How the safeguards work
* `MAX_DAILY_API_CALLS = 30`, `MAX_MONTHLY_API_CALLS = 490` are constants in `cacheManager.js`. They are counted in **Odds API credits** (h2h+spreads+totals for one sport = 3 credits, so about 10 odds refreshes per day (163 per month); soccer requests totals only = 1 credit). Env vars can only *lower* them.
* Every outbound request goes through `guardedFetch()`. If `used + cost > cap` it throws `ApiHardLimitError` **before** any network call, and the user sees: *"⚠️ Daily API Hard Limit Reached to prevent overages. Serving cached/historical estimates only."* Last-known-good data is served if it exists.
* Each Odds API response header (`x-requests-used`) re-syncs the monthly counter, so redeploys can't make it forget real usage.
* Prop lines (3 credits) are fetched only with `/analyze ... live_props:true`.
* Cache TTLs: odds 60 min · standings 12 h · injuries 3 h · H2H 24 h. Cooldown: 5 min per user (`COOLDOWN_SECONDS`).

## The model (short version)
1. **Power rating** = per-game scoring margin from standings, shrunk by `gp/(gp+K)` (early-season protection) + capped last-10 form.
2. **Injuries**: `impact = positionValue × P(missing)`; NBA stars valued by PPG × 0.17. Summed with diminishing returns `cap·(1−e^(−x/cap))`.
3. **Margin** = home strength + home-field edge (+ small H2H nudge) − away strength.
4. **Win / cover probability** = Normal CDF of margin / σ (NBA 12, NFL 13.2, NHL 2.35, MLB 4.4).
5. **Edge**: model probability is blended with the de-vigged market probability (`MODEL_WEIGHT`, default 0.35). EV is measured at the **best available price** across US books.
6. **Props (NBA)**: season average × pace^0.6 × opponent defense × teammate-injury usage bump × blowout-minutes factor; Normal with stat-specific CV.
7. **Lineups**: shows `P1 × P2 × …` plus a correlation-adjusted figure for allowed same-game pairs (team side + same-team player Over), payout, and the parlay's EV.

## Honest limitations
* This is a simple public-data model. Sportsbook lines already embed far more information, so most days it will find **no** edge. That is the correct output, not a bug. Do not treat any "+EV" as a guarantee.
* ESPN endpoints are unofficial and can change shape; parsers are defensive and the model degrades gracefully (a notice appears when data is missing).
* Prop lines are **estimated** unless `live_props` is used. Props only cover the team leaders ESPN lists on the scoreboard (so games must be on today's board). Positional defense is approximated by team defense. NFL/NHL/MLB have game-level markets only.
* NHL/MLB use a Normal margin approximation (crude for low-scoring sports); MLB doesn't model starting pitchers.
* Spread pushes on whole-number lines are ignored.

## Discord setup
1. https://discord.com/developers/applications → **New Application** → copy the **Application ID** (= `CLIENT_ID`).
2. **Bot** tab → **Reset Token** → copy it (= `DISCORD_TOKEN`). No privileged intents needed.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`, permissions *Send Messages* + *Embed Links* → open the URL to invite the bot.
4. Get a free key at https://the-odds-api.com (= `ODDS_API_KEY`).

## Deploy on Railway
1. Push this folder to a GitHub repo (`.env` is git-ignored).
2. Railway → **New Project → Deploy from GitHub repo**. Nixpacks detects Node and runs `npm start`. `railway.json` sets a restart-on-failure policy.
3. Open the service → **Variables** and add: `DISCORD_TOKEN`, `CLIENT_ID`, `ODDS_API_KEY`, and optionally `GUILD_ID` (instant command registration in one server), `THESPORTSDB_KEY`, `COOLDOWN_SECONDS`, `MODEL_WEIGHT`.
4. **Recommended:** add a **Volume** to the service, mount it at `/data`, and set `COUNTER_FILE=/data/usage.json` so the daily counter survives redeploys.
5. **Spending limit:** in your Railway workspace/account **Usage** settings, set a custom usage limit (e.g. $10). Menu names change, so check Railway's current docs.
6. Watch **Deployments → Logs** for `Registered 3 slash commands` and `Logged in as …`.

Local run: `cp .env.example .env`, fill it in, `npm install`, `npm start`. Set `COOLDOWN_SECONDS=0` while testing.


## What the model now uses (v3)

| Input | Source | How it is used |
|---|---|---|
| Where they play | Odds API + ESPN schedule | Home edge, **venue-specific home/road margins** (shrunk, minus the generic home edge so it is not double counted), venue name, altitude (DEN/UTA), road-trip / homestand length |
| Rest & travel | ESPN team schedule | Back-to-back, 3-in-4, extra rest, NFL short week/bye, soccer congestion. Small priors in `situationAdjust()` |
| Who is out | ESPN injuries | Status-weighted penalty; stars valued from points/rebounds/assists leaders (NBA); position weights (NFL/NHL/MLB) |
| Last 10 games | ESPN team schedule | Recency-weighted L10 margin vs season margin replaces the old W-L form proxy; L10 combined scoring is 25% of the total projection |
| Player history | ESPN game logs (NBA) | Last-10 game log blended 55/45 with season average; hit rate is smoothed toward the model and anchored to the market price |
| Weather | ESPN scoreboard | NFL/MLB totals only |

Player props without a real sportsbook line are shown as projections only (no EV, never used in parlays).
ESPN calls are free but capped in `cacheManager.js` (200/day) and cached 3-12 hours; they never touch your Odds API credits.
Run `npm test` (no network, no credits) after any change.

## Best-bets ranking (v3.1)
`/bestbets` now ranks by **probability of hitting**, not EV. Game bets need model AND market to both favour the side with blended p >= `BEST_MIN_P` (0.58); props (NBA) need p >= `BEST_MIN_PROP_P` (0.60) and the last 10 games backing the same side (`BEST_MIN_L10_RATE`, 0.70). `BEST_MAX_NEG_EV` (0.04) stops it recommending heavy juice. All four are env-tunable. Prop lines without `live_props` are estimated: confirm the real line at your book.

## v3.2: history-driven probabilities (model-first)
* `/bestbets` hit probability = `BEST_MODEL_WEIGHT` (default 0.85) x model + the rest market. The market is only a sanity guard (model must favour the side, market may not be strongly against, gap <= 25 pts).
* **Head-to-head is now real.** It used to be a stub that returned 0. It is derived from this season's and last season's meetings (last season at half weight, small samples shrunk). Each old game is stripped of its venue effect, and only the residual vs what the ratings already predict is applied (raw H2H would double-count team strength). Strength: `H2H_WEIGHT_SCALE` (default 4).
* **Home/road splits** carry full weight (`VENUE_WEIGHT`, default 1.0, was 0.5) and ramp faster (n/(n+8)).
* **Early season:** ratings keep more of this year's results (`SHRINK_SCALE`, default 0.6 of the old shrink constant).
* **Injuries** (status-weighted, stars valued by PPG/REB/AST) were already in the strength rating and still are.
* Each pick shows a "why" line: venue record, H2H record, key injuries.
* Costs: one extra free ESPN call per team (prior-season schedule, cached 24h). Watch the 200/day ESPN cap on big slates.

## v3.3: self-tracking (`/record`)
* Every pick `/bestbets` shows is logged (once per day per pick) to `picks.json`. Set `TRACKER_FILE` or `COUNTER_FILE`, and keep it on the Railway Volume so history survives redeploys.
* The bot grades itself: every `GRADE_INTERVAL_MIN` minutes (default 20), and whenever someone runs `/record`, it pulls final scores (game bets) and player game logs (props) from ESPN and marks each pick win / loss / push. Postponed games and DNPs are voided after 36h. These are free ESPN calls counted against the 200/day ESPN cap.
* `/record [period: today | last 7 days | all time] [sport]` shows W-L, hit rate, flat 1-unit profit at real prices (estimated prop lines excluded), predicted vs actual (calibration, with the market's probability for comparison), splits by type / sport / confidence bucket, and each day's result.
* Optional daily recap: set `RECAP_CHANNEL_ID` and the bot posts a recap once a day's picks are all graded.
* "Today" is `TRACK_TZ` (default America/Chicago), not UTC.
* Calibration read needs 20+ graded picks. If it says "overconfident", lower `BEST_MODEL_WEIGHT` or raise `BEST_MIN_P`.

## v3.4: fixes after a 3-6 NBA stretch
**Root cause of picks like Hornets +8.5 vs Celtics.** A spread line is set so the market gives it ~50%. So with the model-heavy probability (v3.2), every spread/total pick was by construction "the model thinks the market's number is wrong", and early-season ratings (10 games, shrunk hard) are the least reliable thing in the system. v3.4:
* **Anchors to the market's own margin/total** and lets history pull it only part of the way (`HIST_ANCHOR` / `TOTAL_ANCHOR`, default 0.5).
* **Last-10 points projection**: each side's expected points = avg(own L10 scored, opponent L10 allowed). Blended 40% into the margin (`L10_WEIGHT`) and 50% into the total (`L10_TOTAL_WEIGHT`).
* **Independent agreement guards** for best bets: ratings AND last-10 must both back the side. Spreads/totals must clear a cushion on both (`SPREAD_CUSHION`, `TOTAL_CUSHION`), and a +6.5 or bigger underdog that has been losing by more than ~60% of the line is blocked.
* **Props use the last 10 as 65% of the projection** and, when there is no live line, recommend a *realistic alt line*: the highest x.5 the model gives >= 78% (`SAFE_LINE_P`) AND the last 10 backs 8/10. Players with no such line are skipped.
* **Suggested slip** under the best bets: singles for the strongest picks, plus at most one 2-leg parlay from different games.
* Picks are tagged with `MODEL_VERSION` so `/record` history can be compared across versions.

## v3.5: classic vs history engines (A/B on real results)
`/bestbets sport [mode]` now has two engines, and both are logged so `/record` shows them side by side ("By engine"):
* **classic** (default): the ORIGINAL bot. Season margin + form, injuries, home edge. No rest/road/venue-split tweaks, no H2H, no last-10 blend, no market anchor, no totals, no props. Probability = 35% model / 65% market (`MODEL_WEIGHT`). Picks need p >= 50%, EV >= 1%, price <= +130, model-vs-market gap <= 20 pts, ranked by EV + 0.3*(p - 0.5), one per game. Tests prove it reproduces the original formulas.
* **history**: the v3.4 engine (last-10 points, market anchor, guards, alt-line props).
Set `BEST_MODE=history` in Railway to change the default. Run both for 1-2 weeks, then compare hit rate in `/record`.

## v3.6: no invented lines, no invented prices (fixes "Giannis over 5.5 REB at -110")
**Root cause.** In history mode, props with no real sportsbook line used `safeLineFor()`: it searched for the highest x.5 the model gave >= 78%, then `evaluateProp()` silently priced it at a made-up -110. So a player averaging 11 rebounds got "Over 5.5 at -110" with a huge fake EV. Real books price a number like that at -1000 or won't offer it.
* **Props are real-line only.** `/bestbets mode:history live_props:true` pulls real sportsbook lines (3 credits per game, next `PROP_GAMES_MAX` = 3 games). Without `live_props` the bot makes no player picks and says so. Props with no line are projection-only (`/analyze` still shows them): no price, no EV, never logged as a bet, never a parlay leg.
* **Prop picks must have a real edge:** both sides priced, EV >= 3% (`BEST_MIN_PROP_EV`), hit probability 54-72% (`BEST_MIN_PROP_P` / `BEST_MAX_PROP_P`), price no worse than about -165 (`BEST_MIN_PROP_DEC`), last 10 backing the side >= 60%, within 20 pts of the de-vigged market. A live line more than `PROP_MAX_GAP_SD` (1.1) standard deviations from our projection is flagged `suspect` (almost always bad inputs) and skipped.
* **Game lines (ML / spread / total) in history mode** now need EV >= 1.5% against the real posted price (`BEST_MIN_EV`; negative EV used to be allowed), probability >= 52%, price between -200 and +200 (`BEST_MIN_DEC` / `BEST_MAX_DEC`), and a model-vs-market gap <= 15 pts (`BEST_MAX_GAP`). Ranked by EV + 0.3 x (p - 0.5) instead of raw hit probability, so heavy favourites no longer float to the top. `BEST_MODEL_WEIGHT` default 0.85 -> 0.6.
* Suggested-slip singles now start at p >= 0.55 (`SLIP_STRAIGHT_P`).
* Picks are tagged version 3.6 in `/record`.
* Not changed: `/parlay`'s "demon alt" legs still use model-derived (not sportsbook) odds and are labelled as estimates.

## v3.7: Kalshi public API (free, no key)
* `services/kalshiService.js` reads Kalshi's public market data (`/series?category=Sports`, `/markets?series_ticker=...&status=open`). It never trades and needs no account or key. Counted against its own polite cap (`kalshi`: 300/day, 6000/month in `cacheManager.js`), cached 10 min (markets) / 12 h (series).
* **NBA player props now get real lines for free.** A Kalshi "Player: 10+ rebounds" contract becomes an Over 9.5 line with real Yes/No prices (Yes ask -> Over, No ask -> Under, with an estimated taker fee: `KALSHI_FEE_RATE`, default 0.07). Kalshi lists a ladder per player (4+, 6+, 8+...); the rung closest to 50/50 is used as the main line. Wide (> `KALSHI_MAX_SPREAD`, 0.08) or thin (< `KALSHI_MIN_VOLUME`) quotes are ignored.
* `/bestbets mode:history` (NBA) and `/analyze` use Kalshi automatically. With `live_props:true` the Odds API sportsbook lines are merged in: same line -> best price per side; different line -> the sportsbook line wins. All the v3.6 pick rules still apply (real price, +EV, realistic probability band, last-10 backing, suspect-line guard).
* `KALSHI_ENABLED=0` turns it off. `KALSHI_BASE_URL` overrides the host.
* **Run `npm run kalshi:probe` once.** Kalshi's market titles and field names were parsed defensively from their documentation, not from live data. The probe prints which series matched, one raw market, and what parsed or was skipped. If a series is missing or props are skipped, paste the output and the matcher can be tuned.
* Not done yet: Kalshi game-winner/total prices as a cross-check on the game-line picks (needs the real ticker format from the probe).
