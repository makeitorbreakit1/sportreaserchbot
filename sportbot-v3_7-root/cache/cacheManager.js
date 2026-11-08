'use strict';
/**
 * cacheManager.js
 *  1. In-memory TTL cache (node-cache) with request de-duplication and "last known good" fallback.
 *  2. HARD-CODED API quota counter. guardedFetch() is the ONLY place in the project that calls fetch().
 *     If a cap would be exceeded it throws BEFORE any network request is made.
 *  3. Per-user slash-command cooldowns.
 */
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

// ───────────────────────── HARD CAPS (units = API credits) ─────────────────────────
const MAX_DAILY_API_CALLS = 30;
const MAX_MONTHLY_API_CALLS = 490;   // Odds API free plan = 500 credits/month; 10 credit buffer

const lowerOnly = (name, hard) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.min(v, hard) : hard;
};
const LIMITS = Object.freeze({
  odds: Object.freeze({ daily: lowerOnly('MAX_DAILY_API_CALLS', MAX_DAILY_API_CALLS), monthly: lowerOnly('MAX_MONTHLY_API_CALLS', MAX_MONTHLY_API_CALLS) }),
  espn: Object.freeze({ daily: 200, monthly: 4000 }),   // free public feed, no credits; capped to be polite
  sportsdb: Object.freeze({ daily: 25, monthly: 500 }),
  kalshi: Object.freeze({ daily: 300, monthly: 6000 }),   // free public market data, no key; capped to be polite
});

const HARD_LIMIT_MESSAGE = '⚠️ Daily API Hard Limit Reached to prevent overages. Serving cached/historical estimates only.';

const TTL = Object.freeze({
  ODDS: 60 * 60,            // 60 min
  PROPS: 45 * 60,
  STANDINGS: 12 * 60 * 60,  // 12 h
  H2H: 24 * 60 * 60,        // 24 h
  INJURIES: 3 * 60 * 60,    // 3 h
  SCOREBOARD: 2 * 60 * 60,  // 2 h
  SCHEDULE: 6 * 60 * 60,    // 6 h  (team results / rest / venue)
  GAMELOG: 6 * 60 * 60,     // 6 h  (player last-10 games)
  KALSHI_SERIES: 12 * 60 * 60,  // 12 h (which Kalshi series exist)
  KALSHI_MARKETS: 10 * 60,      // 10 min (open markets + prices)
});

// ───────────────────────── Usage tracker ─────────────────────────
const STATE_FILE = process.env.COUNTER_FILE || path.join(__dirname, '..', 'data', 'usage.json');
const utcDay = () => new Date().toISOString().slice(0, 10);
const freshState = () => ({ day: utcDay(), month: utcDay().slice(0, 7), usage: {} });

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return freshState();
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s || !s.usage) return freshState();
    
    // Safety check: if saved state day is outdated on load, rollover immediately
    const currentDay = utcDay();
    const currentMonth = currentDay.slice(0, 7);
    if (s.day !== currentDay) {
      s.day = currentDay;
      Object.values(s.usage).forEach(u => { u.d = 0; });
    }
    if (s.month !== currentMonth) {
      s.month = currentMonth;
      Object.values(s.usage).forEach(u => { u.m = 0; u.d = 0; });
    }
    return s;
  } catch { return freshState(); }
}
let state = loadState();

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch { /* non-fatal */ }
}

function rollover() {
  const d = utcDay();
  const m = d.slice(0, 7);
  let changed = false;

  if (state.day !== d) {
    state.day = d;
    Object.values(state.usage).forEach(u => { u.d = 0; });
    changed = true;
  }
  if (state.month !== m) {
    state.month = m;
    Object.values(state.usage).forEach(u => { u.m = 0; u.d = 0; });
    changed = true;
  }
  if (changed) persist();
}
const slot = p => state.usage[p] || (state.usage[p] = { d: 0, m: 0 });

class ApiHardLimitError extends Error {
  constructor(provider, scope) {
    super(HARD_LIMIT_MESSAGE);
    this.name = 'ApiHardLimitError';
    this.provider = provider;
    this.scope = scope; 
  }
}

function reserve(provider, cost = 1) {
  rollover();
  const lim = LIMITS[provider];
  if (!lim) throw new Error(`Unknown API provider "${provider}"`);
  const u = slot(provider);
  if (u.d + cost > lim.daily) throw new ApiHardLimitError(provider, 'daily');
  if (u.m + cost > lim.monthly) throw new ApiHardLimitError(provider, 'monthly');
  u.d += cost; u.m += cost;
  persist();
}

function canAfford(provider, cost = 1) {
  rollover();
  const lim = LIMITS[provider], u = slot(provider);
  return u.d + cost <= lim.daily && u.m + cost <= lim.monthly;
}

function syncProviderUsage(provider, monthlyUsed) {
  const u = slot(provider);
  if (Number.isFinite(monthlyUsed) && monthlyUsed > u.m) { u.m = monthlyUsed; persist(); }
}

function usageSnapshot(provider = 'odds') {
  rollover();
  const u = slot(provider), lim = LIMITS[provider];
  return { daily: { used: u.d, limit: lim.daily }, monthly: { used: u.m, limit: lim.monthly } };
}

async function guardedFetch(provider, url, { cost = 1, headers = {}, timeoutMs = 10000 } = {}) {
  rollover(); // Ensure day check runs before reserving
  reserve(provider, cost);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`${provider} HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return { data: await res.json(), headers: res.headers };
  } catch (e) {
    throw e.name === 'AbortError' ? new Error(`${provider} request timed out`) : e;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── TTL cache ─────────────────────────
const store = new NodeCache({ checkperiod: 300, useClones: false });
const lastGood = new Map();   
const inflight = new Map();   
const LAST_GOOD_MAX = 150;

async function cached(key, ttlSeconds, loader, { optional = false } = {}) {
  const hit = store.get(key);
  if (hit !== undefined) return { value: hit, stale: false, blocked: false };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await loader();
      store.set(key, value, ttlSeconds);
      lastGood.set(key, { value, at: Date.now() });
      if (lastGood.size > LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value);
      return { value, stale: false, blocked: false };
    } catch (err) {
      const blocked = err instanceof ApiHardLimitError;
      if (!blocked) console.warn(`[cache] loader failed for ${key}: ${err.message}`);
      const old = lastGood.get(key);
      if (old) return { value: old.value, stale: true, blocked, staleSince: old.at };
      if (optional) return { value: null, stale: false, blocked, failed: true };
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ───────────────────────── Cooldowns ─────────────────────────
const COOLDOWN_SECONDS = process.env.COOLDOWN_SECONDS !== undefined && process.env.COOLDOWN_SECONDS !== ''
  ? Math.max(0, Number(process.env.COOLDOWN_SECONDS) || 0) : 300;
const cooldowns = new NodeCache({ checkperiod: 60, useClones: false });

function cooldownRemaining(userId) {
  const exp = cooldowns.getTtl(userId);
  return exp ? Math.max(0, Math.ceil((exp - Date.now()) / 1000)) : 0;
}
function startCooldown(userId) {
  if (COOLDOWN_SECONDS > 0) cooldowns.set(userId, 1, COOLDOWN_SECONDS);
}

module.exports = {
  MAX_DAILY_API_CALLS, MAX_MONTHLY_API_CALLS, LIMITS, TTL, HARD_LIMIT_MESSAGE, ApiHardLimitError,
  guardedFetch, cached, canAfford, syncProviderUsage, usageSnapshot, flush: persist,
  cooldownRemaining, startCooldown, COOLDOWN_SECONDS,
};
