# Sports Quant Discord Bot

Slash-command bot (`/analyze`, `/bestbets`, `/parlay`) that runs a transparent quantitative model on **free API tiers** with a **hard-coded quota stop**.

## Project layout
```
index.js                     bot startup, command registration, routing, reconnect/shutdown
cache/cacheManager.js        TTL cache, HARD API caps, guardedFetch (only fetch() in the project), cooldowns
services/oddsService.js      Odds API + ESPN public feeds + TheSportsDB, credit-preserving
services/analyticsEngine.js  ratings, injury model, win/cover probability, EV, props, parlay math
commands/                    analyze.js, bestbets.js, parlay.js, embeds.js
test/                        `npm test`: math + mocked end-to-end tests (no network, no credits)
```

## How the safeguards work
* `MAX_DAILY_API_CALLS = 12`, `MAX_MONTHLY_API_CALLS = 380` are constants in `cacheManager.js`. They are counted in **Odds API credits** (h2h+spreads+totals for one sport = 3 credits, so only 4 odds refreshes per day; soccer requests totals only = 1 credit). Env vars can only *lower* them.
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
