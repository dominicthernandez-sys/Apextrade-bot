const express = require("express");
const path    = require("path");
const crypto  = require("crypto");
const app     = express();
app.use(express.json());
app.use(express.static(__dirname));

// ════════════════════════════════════════════════════════════════════════════
//  APEX TRADE v3.2 — MEAN REVERSION ENGINE
//  Strategy: RSI(2) oversold + Bollinger Band lower touch → swing long
//  Hold: 1–5 days on daily bars  |  Exit: price reverts to 20-period MA
//  Crypto: same logic on 1-hour bars, runs 24/7 independently
//
//  FIX v3.2: Stock loss limit check now relies solely on stockLossLimitHit
//  flag instead of comparing sPnl <= dailyLossLimit. The old comparison
//  evaluated 0 <= 0 on every fresh boot, instantly pausing the stock bot
//  before it ever ran. dailyLossLimit is now initialized to -Infinity so
//  a raw numeric comparison can never accidentally trigger on boot.
// ════════════════════════════════════════════════════════════════════════════

// ─── ENV CONFIG ───────────────────────────────────────────────────────────────
const AKEY       = process.env.ALPACA_KEY_ID;
const ASECRET    = process.env.ALPACA_SECRET_KEY;
const PAPER      = process.env.PAPER_TRADING !== "false";
const ABASE      = PAPER ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
const ADATA      = "https://data.alpaca.markets";
const AHDR       = { "APCA-API-KEY-ID": AKEY, "APCA-API-SECRET-KEY": ASECRET };

// ─── RISK CONFIG ──────────────────────────────────────────────────────────────
const MAX_RISK_PCT     = 0.02;   // 2% of equity risked per trade
const MAX_POSITIONS    = 5;      // max simultaneous open stock positions
const DAILY_LOSS_PCT   = 0.04;   // stop stock trading if day P&L drops 4% of equity
const MAX_DAILY_TRADES = 10;     // quality over quantity
const MIN_RR_RATIO     = 1.5;    // only take trades where reward ≥ 1.5× risk

// ─── STOCK STRATEGY PARAMS ────────────────────────────────────────────────────
const RSI_PERIOD      = 2;    // RSI(2) — catches extreme short-term oversold
const RSI_ENTRY       = 10;   // entry threshold
const RSI_EXIT        = 70;   // exit when overbought — snap-back complete
const BB_PERIOD       = 20;   // Bollinger Band period
const BB_STD          = 2.0;  // standard deviations
const TREND_MA_PERIOD = 200;  // long-term trend filter
const STOP_PCT        = 0.05; // 5% hard stop
const TIME_STOP_BARS  = 5;    // exit after 5 daily bars with no reversion

// ─── CRYPTO PARAMS ────────────────────────────────────────────────────────────
// Crypto runs 24/7 on 1-hour bars. Thresholds are wider due to crypto volatility.
const CRYPTO_RSI_ENTRY  = 15;   // more extreme oversold required
const CRYPTO_RSI_EXIT   = 75;   // exit overbought threshold
const CRYPTO_STOP_PCT   = 0.08; // 8% stop — crypto needs more room
const CRYPTO_TIME_BARS  = 12;   // 12 hours max hold with no reversion
const CRYPTO_MAX_TOTAL  = 100;  // hard budget cap across all crypto
const CRYPTO_RISK_PCT   = 0.20; // 20% of available budget per signal
const CRYPTO_FEE_PCT    = 0.006;
const CRYPTO_BREAKEVEN  = CRYPTO_FEE_PCT * 2 * 100; // 1.2% round-trip cost

// ─── CRYPTO DAILY RESET CONFIG ────────────────────────────────────────────────
// Crypto has its OWN daily reset that runs at UTC midnight.
// This is separate from the stock reset (which only runs during market hours).
// Without this, cPnl never resets and the 30% loss limit never clears — even
// after a new day begins. The stock bot may be stopped on weekends so it cannot
// be relied upon to trigger maybeDailyReset for crypto.
const CRYPTO_RESET_HOUR_UTC = 0; // reset crypto state at midnight UTC

// ─── FOCUSED UNIVERSE ────────────────────────────────────────────────────────
const STOCKS = [
  "SPY", "QQQ", "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META",
  "TSLA", "AMD", "AVGO", "MU", "COIN", "PLTR", "ARM"
];
const CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD"];

// ─── COINBASE CONFIG ──────────────────────────────────────────────────────────
const CB_KEY_NAME        = process.env.COINBASE_KEY_NAME || "";
const CB_PRIVATE_KEY_RAW = (process.env.COINBASE_PRIVATE_KEY || "")
  .replace(/\\n/g, "\n").replace(/\r/g, "").trim();
const CB_BASE       = "https://api.coinbase.com";
const CB_KEY_IS_PEM = CB_PRIVATE_KEY_RAW.includes("-----BEGIN");

console.log("[BOOT] Alpaca paper:", PAPER);
console.log("[BOOT] Strategy: MEAN REVERSION | RSI(2) + Bollinger Bands + 200MA trend filter");
console.log(`[BOOT] Stock entry: RSI(2) < ${RSI_ENTRY} + below BB lower + above MA(${TREND_MA_PERIOD})`);
console.log(`[BOOT] Stock exit: MA reversion OR RSI(2) > ${RSI_EXIT} OR -${STOP_PCT*100}% stop OR ${TIME_STOP_BARS}-bar time stop`);
console.log(`[BOOT] Risk: ${MAX_RISK_PCT*100}% equity/trade | max ${MAX_POSITIONS} positions | ${MAX_DAILY_TRADES} trades/day`);
console.log(`[BOOT] Crypto: 24/7 | RSI(2) < ${CRYPTO_RSI_ENTRY} + below BB | 1hr bars | resets at UTC midnight`);

// ─── STATE ────────────────────────────────────────────────────────────────────
let stockRunning = false, cryptoRunning = false;
let stockTimer = null, cTimer = null;

// Stock daily reset
let lastStockResetDay = "";
let stockLossLimitHit = false;
let sPnl = 0, sTrades = [], sSigs = [], sPrices = {};
let sEntryCount = {}, sPositionMeta = {};
let sDailyTradeCount = 0;
// FIX: Initialize to -Infinity so a numeric comparison can never
// accidentally fire on boot when both sPnl and dailyLossLimit are 0.
// The actual limit is set correctly inside maybeStockDailyReset() once
// equity is known. Loss limit enforcement now relies on stockLossLimitHit.
let dailyLossLimit = -Infinity;
let sHistory = {};

// Crypto daily reset — INDEPENDENT of stock bot
let lastCryptoResetDay = "";
let cryptoLossLimitHit = false;
let cPnl = 0, cTrades = [], cSigs = [], cPrices = {};
let cHistory = {}, cEntryPrice = {}, cPositionMeta = {};

// ─── STOCK DAILY RESET ────────────────────────────────────────────────────────
// Only runs during market hours on weekdays. Resets stock-specific state.
function maybeStockDailyReset(equity) {
  const now      = new Date();
  const day      = now.getUTCDay();
  const hour     = now.getUTCHours();
  const min      = now.getUTCMinutes();
  const todayNum = now.toISOString().slice(0, 10);

  if (day === 0 || day === 6) return; // no reset on weekends
  if (hour < 13 || (hour === 13 && min < 30)) return; // before market open
  if (lastStockResetDay === todayNum) return; // already reset today

  lastStockResetDay   = todayNum;
  sPnl                = 0;
  sEntryCount         = {};
  sDailyTradeCount    = 0;
  stockLossLimitHit   = false;
  dailyLossLimit      = -Infinity; // reset to safe default until equity is known

  if (equity > 0) {
    dailyLossLimit = -(equity * DAILY_LOSS_PCT);
    console.log(`[STOCK RESET] Daily loss limit set: $${Math.abs(dailyLossLimit).toFixed(2)} (${DAILY_LOSS_PCT*100}% of $${equity.toFixed(2)})`);
  }

  console.log("[STOCK RESET] Daily state reset for", todayNum);
}

// ─── CRYPTO DAILY RESET ───────────────────────────────────────────────────────
// Runs at UTC midnight every day — completely independent of the stock bot.
// This is the key fix that makes crypto truly 24/7: crypto state resets even
// on weekends and holidays when the stock bot is idle.
function maybeCryptoDailyReset() {
  const now      = new Date();
  const todayNum = now.toISOString().slice(0, 10);

  // Reset at UTC midnight regardless of weekday
  if (lastCryptoResetDay === todayNum) return;

  lastCryptoResetDay  = todayNum;
  cPnl                = 0;
  cryptoLossLimitHit  = false;
  // Note: we deliberately do NOT reset cEntryPrice or cPositionMeta here.
  // Crypto positions can span multiple days — resetting those mid-hold
  // would cause the bot to lose track of an active position and never exit it.

  console.log(`[CRYPTO RESET] Daily state reset for ${todayNum} | cPnl reset to $0 | loss limit cleared`);
}

// ─── ALPACA HELPERS ───────────────────────────────────────────────────────────
function aget(u) {
  return fetch(ABASE + u, { headers: AHDR }).then(r => r.json());
}
function apost(u, b) {
  return fetch(ABASE + u, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AHDR },
    body: JSON.stringify(b)
  }).then(r => r.json());
}
function dget(u) {
  return fetch(ADATA + u, { headers: AHDR }).then(r => r.json());
}

// ─── COINBASE JWT ─────────────────────────────────────────────────────────────
function makeCBJWT(method, reqPath) {
  try {
    if (!CB_KEY_NAME || !CB_PRIVATE_KEY_RAW) return null;
    const now   = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const hdr   = { alg: CB_KEY_IS_PEM ? "ES256" : "EdDSA", kid: CB_KEY_NAME, nonce, typ: "JWT" };
    const pay   = { iss: "cdp", nbf: now, exp: now + 120, sub: CB_KEY_NAME, aud: ["cdp_service"], uri: `${method} api.coinbase.com${reqPath}` };
    const h     = Buffer.from(JSON.stringify(hdr)).toString("base64url");
    const p     = Buffer.from(JSON.stringify(pay)).toString("base64url");
    const msg   = `${h}.${p}`;
    let sig;
    if (CB_KEY_IS_PEM) {
      const key = crypto.createPrivateKey({ key: CB_PRIVATE_KEY_RAW, format: "pem" });
      sig = crypto.sign(null, Buffer.from(msg), { key, dsaEncoding: "ieee-p1363", algorithm: "SHA256" });
    } else {
      const raw   = Buffer.from(CB_PRIVATE_KEY_RAW, "base64");
      const seed  = raw.slice(0, 32);
      const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
      const key   = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
      sig = crypto.sign(null, Buffer.from(msg), key);
    }
    return `${msg}.${sig.toString("base64url")}`;
  } catch(e) { console.error("[CB JWT]", e.message); return null; }
}

async function testCoinbaseAuth() {
  if (!CB_KEY_NAME || !CB_PRIVATE_KEY_RAW) { console.warn("[CB AUTH] Keys not configured"); return; }
  try {
    const jwt = makeCBJWT("GET", "/api/v3/brokerage/accounts");
    if (!jwt) { console.error("[CB AUTH] ❌ JWT failed"); return; }
    const data = await fetch(`${CB_BASE}/api/v3/brokerage/accounts`, {
      headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" }
    }).then(r => r.json());
    if (data.accounts) {
      console.log(`[CB AUTH] ✅ OK — ${data.accounts.length} accounts`);
      data.accounts.forEach(a => {
        const bal = parseFloat(a.available_balance?.value || 0);
        if (bal > 0 || a.currency === "USD")
          console.log(`  [CB] ${a.currency}: $${bal.toFixed(2)}`);
      });
    } else {
      console.error("[CB AUTH] ❌", data.error);
    }
  } catch(e) { console.error("[CB AUTH] ❌", e.message); }
}

function cbget(p) {
  const t = makeCBJWT("GET", p);
  if (!t) return Promise.resolve({ _jwtFailed: true });
  return fetch(CB_BASE + p, { headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" } })
    .then(async r => { try { return JSON.parse(await r.text()); } catch { return {}; } })
    .catch(e => { console.error("[CB GET]", e.message); return {}; });
}
function cbpost(p, b) {
  const t = makeCBJWT("POST", p);
  if (!t) return Promise.resolve({ _jwtFailed: true });
  return fetch(CB_BASE + p, {
    method: "POST",
    headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(b)
  })
    .then(r => r.json())
    .catch(e => { console.error("[CB POST]", e.message); return {}; });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INDICATOR LIBRARY
// ═══════════════════════════════════════════════════════════════════════════════

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period, stdMult) {
  if (closes.length < period) return null;
  const slice    = closes.slice(-period);
  const mid      = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mid, 2), 0) / period;
  const std      = Math.sqrt(variance);
  return { upper: mid + stdMult * std, mid, lower: mid - stdMult * std, std, bWidth: ((std * 2 * stdMult) / mid) * 100 };
}

function calcATR(highs, lows, closes, period) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── DAILY BAR FETCHER ────────────────────────────────────────────────────────
async function fetchDailyBars(symbols, limit = 250) {
  try {
    const url  = `/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(","))}&timeframe=1Day&limit=${limit}&feed=iex`;
    const data = await dget(url);
    const result = {};
    if (data && typeof data === "object") {
      const bars = data.bars || data;
      for (const sym of symbols) {
        const barArr = bars[sym];
        if (!Array.isArray(barArr) || barArr.length < 5) continue;
        result[sym] = {
          closes:  barArr.map(b => b.c),
          opens:   barArr.map(b => b.o),
          highs:   barArr.map(b => b.h),
          lows:    barArr.map(b => b.l),
          volumes: barArr.map(b => b.v),
          count:   barArr.length
        };
      }
    }
    return result;
  } catch(e) { console.error("[fetchDailyBars]", e.message); return {}; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MEAN REVERSION SIGNAL ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function getMeanReversionSignal(sym, history, currentPosition) {
  if (!history || history.count < TREND_MA_PERIOD + 5) {
    return { type: null, reason: `warming up (${history?.count || 0}/${TREND_MA_PERIOD + 5} bars)` };
  }

  const closes = history.closes;
  const highs  = history.highs;
  const lows   = history.lows;
  const price  = closes[closes.length - 1];

  const rsi2  = calcRSI(closes.slice(-20), RSI_PERIOD);
  const bb    = calcBB(closes, BB_PERIOD, BB_STD);
  const ma200 = calcSMA(closes, TREND_MA_PERIOD);
  const atr14 = calcATR(highs, lows, closes, 14);

  if (rsi2 === null || !bb || !ma200) return { type: null, reason: "indicators not ready" };

  // ── EXIT LOGIC ──────────────────────────────────────────────────────────────
  if (currentPosition) {
    const ep       = parseFloat(currentPosition.avg_entry_price || price);
    const gp       = ((price - ep) / ep) * 100;
    const barsHeld = sPositionMeta[sym]?.barsHeld || 0;

    if (gp <= -(STOP_PCT * 100)) {
      return { type: "EXIT_STOP", reason: `stop-loss ${gp.toFixed(2)}% (limit: -${STOP_PCT*100}%)`, price, rsi: rsi2, bb, ma200, atr: atr14, gainPct: gp };
    }
    if (barsHeld >= TIME_STOP_BARS && gp < 1) {
      return { type: "EXIT_TIME", reason: `time stop — ${barsHeld} bars held, only ${gp.toFixed(2)}% gain`, price, rsi: rsi2, bb, ma200, atr: atr14, gainPct: gp };
    }
    if (price >= bb.mid) {
      return { type: "EXIT_PROFIT", reason: `mean achieved — $${price.toFixed(2)} ≥ MA20 ($${bb.mid.toFixed(2)})`, price, rsi: rsi2, bb, ma200, atr: atr14, gainPct: gp };
    }
    if (rsi2 >= RSI_EXIT) {
      return { type: "EXIT_PROFIT", reason: `RSI(2)=${rsi2.toFixed(1)} — overbought, snap-back complete`, price, rsi: rsi2, bb, ma200, atr: atr14, gainPct: gp };
    }
    return { type: null, reason: `holding — ${gp.toFixed(2)}% | RSI: ${rsi2.toFixed(1)} | ${barsHeld}/${TIME_STOP_BARS} bars`, rsi: rsi2, bb, ma200 };
  }

  // ── ENTRY LOGIC ─────────────────────────────────────────────────────────────
  const isOversold       = rsi2 < RSI_ENTRY;
  const isBelowBB        = price <= bb.lower;
  const isAboveTrend     = price > ma200;
  const bandNotExploding = bb.bWidth < 15;

  if (isOversold && isBelowBB && isAboveTrend) {
    const targetPrice = bb.mid;
    const stopPrice   = price * (1 - STOP_PCT);
    const potentialR  = ((targetPrice - price) / price) * 100;
    const rrRatio     = potentialR / (STOP_PCT * 100);

    if (rrRatio < MIN_RR_RATIO) {
      return { type: null, reason: `R:R ${rrRatio.toFixed(2)} below minimum ${MIN_RR_RATIO} — skip`, rsi: rsi2, bb, ma200 };
    }

    const confidence = Math.min(99, Math.round(
      50 +
      (RSI_ENTRY - rsi2) * 2 +
      (bandNotExploding ? 10 : 0) +
      Math.min(15, rrRatio * 3)
    ));

    return {
      type: "BUY",
      reason: `RSI(2)=${rsi2.toFixed(1)} | $${price.toFixed(2)} below BB($${bb.lower.toFixed(2)}) | above MA200($${ma200.toFixed(2)}) | R:R ${rrRatio.toFixed(2)}`,
      confidence, price, targetPrice,
      stopPrice:  parseFloat(stopPrice.toFixed(2)),
      rrRatio:    parseFloat(rrRatio.toFixed(2)),
      rsi: rsi2, bb, ma200, atr: atr14
    };
  }

  return {
    type: null,
    reason: [
      isOversold   ? `✓ RSI(2)=${rsi2.toFixed(1)}<${RSI_ENTRY}` : `✗ RSI(2)=${rsi2.toFixed(1)} (need <${RSI_ENTRY})`,
      isBelowBB    ? `✓ below BB`     : `✗ above BB lower $${bb.lower.toFixed(2)}`,
      isAboveTrend ? `✓ above MA200`  : `✗ below MA200 $${ma200.toFixed(2)} — downtrend skip`
    ].join(" | "),
    rsi: rsi2, bb, ma200
  };
}

// ─── POSITION SIZING ──────────────────────────────────────────────────────────
function calcPositionSize(equity, price, stopPrice) {
  const dollarRisk   = equity * MAX_RISK_PCT;
  const riskPerShare = price - stopPrice;
  if (riskPerShare <= 0) return 0;
  const shares = Math.floor(dollarRisk / riskPerShare);
  const maxCost = equity * 0.25; // max 25% of equity per position
  return Math.max(1, shares * price > maxCost ? Math.floor(maxCost / price) : shares);
}

// ─── MARKET HOURS ─────────────────────────────────────────────────────────────
function isMarketHours() {
  const now  = new Date();
  const day  = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins < 20 * 60;
}

// ─── P&L STATS ────────────────────────────────────────────────────────────────
function calcPnlStats(tradeList) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekStart  = new Date(); weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  function stats(list) {
    let total = 0, wins = 0, losses = 0;
    list.forEach(t => { if (t.pnl != null) { total += t.pnl; if (t.pnl > 0) wins++; else if (t.pnl < 0) losses++; } });
    return { total: parseFloat(total.toFixed(2)), wins, losses };
  }
  const now = Date.now();
  return {
    today: stats(tradeList.filter(t => new Date(t.date || now) >= todayStart)),
    week:  stats(tradeList.filter(t => new Date(t.date || now) >= weekStart)),
    month: stats(tradeList.filter(t => new Date(t.date || now) >= monthStart))
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STOCK TICK — 60s interval, market hours only
// ═══════════════════════════════════════════════════════════════════════════════
async function stockTick() {
  if (!stockRunning) return;

  try {
    const acct   = await aget("/v2/account");
    const equity = parseFloat(acct.equity || 0);

    maybeStockDailyReset(equity);

    // FIX: Only check the flag, not sPnl <= dailyLossLimit.
    // The flag is set inside the loss-limit block below when a real breach
    // occurs during an active trading day. Comparing raw numbers caused a
    // 0 <= 0 false positive on every cold boot, instantly killing the bot.
    if (stockLossLimitHit) {
      console.log(`[STOCKS] Loss limit flag set — pausing stock bot.`);
      stockRunning = false;
      clearInterval(stockTimer);
      stockTimer = null;
      return;
    }

    // Actual intra-day loss limit enforcement — only triggers after
    // dailyLossLimit has been set to a real negative value by maybeStockDailyReset.
    if (dailyLossLimit !== -Infinity && sPnl <= dailyLossLimit) {
      console.log(`[STOCKS] Daily loss limit hit ($${sPnl.toFixed(2)} / $${dailyLossLimit.toFixed(2)}). Pausing.`);
      stockLossLimitHit = true;
      stockRunning = false;
      clearInterval(stockTimer);
      stockTimer = null;
      return;
    }

    if (!isMarketHours()) return;

    const bars = await fetchDailyBars(STOCKS, 250);
    for (const sym of STOCKS) {
      if (bars[sym]) sHistory[sym] = bars[sym];
    }

    const posArr = await aget("/v2/positions");
    const posMap = {};
    if (Array.isArray(posArr)) posArr.forEach(p => { posMap[p.symbol] = p; });

    // Increment bar counters once per trading day per position
    const today = new Date().toISOString().slice(0, 10);
    for (const sym of Object.keys(posMap)) {
      if (!sPositionMeta[sym]) sPositionMeta[sym] = { barsHeld: 0 };
      const meta = sPositionMeta[sym];
      if (meta.lastBarDate !== today) {
        meta.barsHeld++;
        meta.lastBarDate = today;
      }
    }
    for (const sym of Object.keys(sPositionMeta)) {
      if (!posMap[sym]) delete sPositionMeta[sym];
    }

    sSigs = [];

    for (const sym of STOCKS) {
      const history = sHistory[sym];
      const price   = history?.closes?.[history.closes.length - 1];
      if (price) sPrices[sym] = price;
      if (!price || !history) continue;

      const sig = getMeanReversionSignal(sym, history, posMap[sym] || null);

      if (sig.type === "BUY" || sig.rsi !== undefined) {
        sSigs.push({
          symbol: sym, type: sig.type || "WATCH",
          confidence: sig.confidence || 0,
          reason: sig.reason, price,
          rsi:         sig.rsi  !== undefined ? parseFloat(sig.rsi.toFixed(1))    : null,
          bbLower:     sig.bb?.lower           ? parseFloat(sig.bb.lower.toFixed(2)) : null,
          ma200:       sig.ma200               ? parseFloat(sig.ma200.toFixed(2))   : null,
          targetPrice: sig.targetPrice || null,
          rrRatio:     sig.rrRatio || null,
          time: new Date().toLocaleTimeString(), market: "stocks"
        });
      }

      // Exits
      if (posMap[sym] && ["EXIT_PROFIT", "EXIT_STOP", "EXIT_TIME"].includes(sig.type)) {
        const pos = posMap[sym];
        const qty = Math.abs(parseInt(pos.qty));
        const ord = await apost("/v2/orders", { symbol: sym, qty, side: "sell", type: "market", time_in_force: "day" });
        if (ord.id) {
          const pnlDollars = parseFloat(pos.unrealized_pl || 0);
          sPnl += pnlDollars;
          sTrades.unshift({
            id: ord.id, symbol: sym, side: "SELL", qty, price,
            pnl: pnlDollars, exitType: sig.type,
            reason: sig.reason, gainPct: sig.gainPct,
            barsHeld: sPositionMeta[sym]?.barsHeld || 0,
            time: new Date().toLocaleTimeString(),
            market: "stocks", date: new Date().toISOString()
          });
          if (sTrades.length > 500) sTrades.pop();
          delete sPositionMeta[sym];
          delete sEntryCount[sym];
          console.log(`[${sig.type}] ${sym} ${qty}sh @ $${price} | ${sig.reason} | P&L: $${pnlDollars.toFixed(2)}`);
        }
        continue;
      }

      // Entries
      if (sig.type === "BUY") {
        if (Object.keys(posMap).length >= MAX_POSITIONS) { console.log(`[SKIP] ${sym} — max ${MAX_POSITIONS} positions`); continue; }
        if (sDailyTradeCount >= MAX_DAILY_TRADES)        { console.log(`[SKIP] ${sym} — daily trade cap`); continue; }
        if (posMap[sym]) continue;

        const qty  = calcPositionSize(equity, price, sig.stopPrice);
        if (qty < 1) { console.log(`[SKIP] ${sym} — position size < 1`); continue; }

        const cost = qty * price;
        const cash = parseFloat(acct.cash || 0);
        if (cost > cash * 0.95) { console.log(`[SKIP] ${sym} — insufficient cash`); continue; }

        const ord = await apost("/v2/orders", { symbol: sym, qty, side: "buy", type: "market", time_in_force: "day" });
        if (ord.id) {
          await apost("/v2/orders", { symbol: sym, qty, side: "sell", type: "stop", stop_price: sig.stopPrice, time_in_force: "gtc" });
          sEntryCount[sym]   = 1;
          sPositionMeta[sym] = { barsHeld: 0, lastBarDate: today };
          sDailyTradeCount++;
          sTrades.unshift({
            id: ord.id, symbol: sym, side: "BUY", qty, price,
            stopPrice: sig.stopPrice, targetPrice: sig.targetPrice,
            rrRatio: sig.rrRatio, confidence: sig.confidence,
            pnl: null, reason: sig.reason,
            dollarRisk: parseFloat((qty * (price - sig.stopPrice)).toFixed(2)),
            time: new Date().toLocaleTimeString(),
            market: "stocks", date: new Date().toISOString()
          });
          if (sTrades.length > 500) sTrades.pop();
          console.log(`[BUY] ${sym} ${qty}sh @ $${price} | stop $${sig.stopPrice} | target $${sig.targetPrice?.toFixed(2)} | R:R ${sig.rrRatio} | risk $${(qty*(price-sig.stopPrice)).toFixed(2)} | trades ${sDailyTradeCount}/${MAX_DAILY_TRADES}`);
        }
      }
    }
  } catch(e) { console.error("[Stock tick error]:", e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CRYPTO TICK — 10min interval, 24/7, independent reset
//
//  Key differences from stock tick:
//  1. No isMarketHours() check — runs at all hours including weekends
//  2. Calls maybeCryptoDailyReset() directly — not reliant on stock bot
//  3. Increments barsHeld by checking elapsed hours since entry, not day count
//     so the time stop works correctly across overnight and weekend holds
//  4. Loss limit is budget-relative (30% of $100 cap) not equity-relative
// ═══════════════════════════════════════════════════════════════════════════════
async function cryptoTick() {
  if (!cryptoRunning) return;

  // Independent daily reset — runs at UTC midnight regardless of stock bot
  maybeCryptoDailyReset();

  // Check crypto loss limit
  if (cPnl <= -(CRYPTO_MAX_TOTAL * 0.30) || cryptoLossLimitHit) {
    if (!cryptoLossLimitHit) {
      console.log(`[CRYPTO] 30% budget loss limit hit ($${cPnl.toFixed(2)}). Pausing.`);
      cryptoLossLimitHit = true;
    }
    cryptoRunning = false;
    clearInterval(cTimer);
    cTimer = null;
    return;
  }

  try {
    // Fetch 1-hour bars for each pair
    for (const pair of CRYPTO) {
      try {
        const res = await cbget(`/api/v3/brokerage/products/${pair}/candles?granularity=ONE_HOUR&limit=60`);
        if (res?.candles && Array.isArray(res.candles)) {
          const candles = res.candles.slice().reverse(); // CB returns newest first
          const closes  = candles.map(c => parseFloat(c.close));
          const highs   = candles.map(c => parseFloat(c.high));
          const lows    = candles.map(c => parseFloat(c.low));
          if (closes.length > 0) {
            cPrices[pair]  = closes[closes.length - 1];
            cHistory[pair] = { closes, highs, lows, count: closes.length };
          }
        }
      } catch(e) {
        // Fallback: fetch spot price if candles fail
        const res = await cbget(`/api/v3/brokerage/products/${pair}`);
        const p   = parseFloat(res?.price || 0);
        if (p > 0) cPrices[pair] = p;
        console.warn(`[CRYPTO] ${pair} candles failed — using spot price $${p}`);
      }
    }

    const accRes = await cbget("/api/v3/brokerage/accounts");
    const cbAcc  = {};
    if (accRes?.accounts) accRes.accounts.forEach(a => { cbAcc[a.currency] = a; });
    const usdBal = parseFloat(cbAcc["USD"]?.available_balance?.value || 0);

    // Tally deployed budget across all holdings
    let totalDeployed = 0;
    for (const pair of CRYPTO) {
      const coin    = pair.replace("-USD", "");
      const holding = parseFloat(cbAcc[coin]?.available_balance?.value || 0);
      const price   = cPrices[pair] || 0;
      totalDeployed += holding * price;
    }

    cSigs = [];

    for (const pair of CRYPTO) {
      const price   = cPrices[pair];
      const history = cHistory[pair];
      if (!price || !history || history.count < 30) {
        console.log(`[CRYPTO] ${pair} warming up (${history?.count || 0}/30 bars)`);
        continue;
      }

      const rsi  = calcRSI(history.closes.slice(-20), RSI_PERIOD);
      const bb   = calcBB(history.closes, BB_PERIOD, BB_STD);
      if (rsi === null || !bb) continue;

      const coin         = pair.replace("-USD", "");
      const holdingCoins = parseFloat(cbAcc[coin]?.available_balance?.value || 0);
      const holdingValue = holdingCoins * price;
      const entryPrice   = cEntryPrice[pair];
      const gp           = entryPrice ? ((price - entryPrice) / entryPrice) * 100 : 0;
      const meta         = cPositionMeta[pair] || {};

      // Time stop uses real elapsed hours, not a bar count.
      // This correctly handles overnight holds and weekend crypto trading.
      const ageHours = meta.entryTime
        ? (Date.now() - meta.entryTime) / 3600000
        : 0;

      console.log(`[CRYPTO] ${pair} | RSI(2)=${rsi.toFixed(1)} | $${price.toFixed(2)} | BB lower $${bb.lower.toFixed(2)} | holding $${holdingValue.toFixed(2)}${holdingValue > 0 ? ` | ${gp.toFixed(2)}% | ${ageHours.toFixed(1)}hr` : ""}`);

      cSigs.push({
        symbol: pair, price,
        rsi:    parseFloat(rsi.toFixed(1)),
        bbLower:parseFloat(bb.lower.toFixed(2)),
        bbMid:  parseFloat(bb.mid.toFixed(2)),
        holding: holdingValue > 0,
        gainPct: holdingValue > 0 ? parseFloat(gp.toFixed(2)) : null,
        ageHours: parseFloat(ageHours.toFixed(1)),
        time: new Date().toLocaleTimeString(), market: "crypto"
      });

      // ── CRYPTO EXITS ──────────────────────────────────────────────────────
      if (holdingCoins > 0 && entryPrice) {
        let why = "", sellAmt = null;

        // Profit: mean achieved
        if (price >= bb.mid) {
          why     = `mean achieved — $${price.toFixed(2)} ≥ MA20 ($${bb.mid.toFixed(2)}) | net ~${(gp - CRYPTO_BREAKEVEN).toFixed(2)}% after fees`;
          sellAmt = holdingCoins.toFixed(8);
        }
        // Profit: RSI overbought
        else if (rsi >= CRYPTO_RSI_EXIT) {
          why     = `RSI(2)=${rsi.toFixed(1)} overbought — snap-back complete`;
          sellAmt = holdingCoins.toFixed(8);
        }
        // Hard stop
        if (gp <= -(CRYPTO_STOP_PCT * 100)) {
          why     = `stop-loss ${gp.toFixed(2)}% from entry $${entryPrice.toFixed(2)}`;
          sellAmt = holdingCoins.toFixed(8);
        }
        // Time stop — based on real elapsed hours
        if (ageHours >= CRYPTO_TIME_BARS && gp < 1) {
          why     = `time stop — ${ageHours.toFixed(1)}hr held, only ${gp.toFixed(2)}% gain`;
          sellAmt = holdingCoins.toFixed(8);
        }

        if (why && sellAmt && parseFloat(sellAmt) * price >= 2) {
          const sord = await cbpost("/api/v3/brokerage/orders", {
            client_order_id: crypto.randomUUID(),
            product_id: pair, side: "SELL",
            order_configuration: { market_market_ioc: { base_size: sellAmt } }
          });
          if (sord?.success) {
            const soldCoins = parseFloat(sellAmt);
            const grossPnl  = soldCoins * (price - entryPrice);
            const feeCost   = soldCoins * price * CRYPTO_FEE_PCT;
            const netPnl    = grossPnl - feeCost;
            cPnl += netPnl;
            delete cEntryPrice[pair];
            delete cPositionMeta[pair];
            cTrades.unshift({
              id: sord.success_response?.order_id || Date.now().toString(),
              symbol: pair, side: "SELL", qty: sellAmt, price,
              pnl: parseFloat(netPnl.toFixed(2)), entryPrice,
              reason: why, ageHours: parseFloat(ageHours.toFixed(1)),
              time: new Date().toLocaleTimeString(),
              market: "crypto", date: new Date().toISOString()
            });
            if (cTrades.length > 100) cTrades.pop();
            console.log(`[CRYPTO EXIT] ${pair} | ${why} | Net P&L: $${netPnl.toFixed(2)} | total crypto P&L: $${cPnl.toFixed(2)}`);
          } else {
            console.error(`[CRYPTO SELL FAILED] ${pair}:`, JSON.stringify(sord).substring(0, 200));
          }
        }
      }

      // ── CRYPTO ENTRY ──────────────────────────────────────────────────────
      if (holdingCoins <= 0 && rsi < CRYPTO_RSI_ENTRY && price <= bb.lower) {
        const available = Math.max(0, CRYPTO_MAX_TOTAL - totalDeployed);
        const budget    = Math.min(available * CRYPTO_RISK_PCT, usdBal * 0.9, 40);

        if (budget < 2) {
          console.log(`[CRYPTO SKIP] ${pair} — budget exhausted (deployed $${totalDeployed.toFixed(2)}/$${CRYPTO_MAX_TOTAL})`);
          continue;
        }

        const order = await cbpost("/api/v3/brokerage/orders", {
          client_order_id: crypto.randomUUID(),
          product_id: pair, side: "BUY",
          order_configuration: { market_market_ioc: { quote_size: budget.toFixed(2) } }
        });

        if (order?.success) {
          cEntryPrice[pair]   = price;
          cPositionMeta[pair] = { entryTime: Date.now() }; // real timestamp for accurate time stop
          totalDeployed      += budget; // update tally so next pair sees reduced budget

          cTrades.unshift({
            id: order.success_response?.order_id || Date.now().toString(),
            symbol: pair, side: "BUY", qty: `$${budget.toFixed(2)}`, price,
            entryPrice: price, pnl: null,
            reason: `RSI(2)=${rsi.toFixed(1)} below BB lower $${bb.lower.toFixed(2)} | target MA $${bb.mid.toFixed(2)}`,
            time: new Date().toLocaleTimeString(),
            market: "crypto", date: new Date().toISOString()
          });
          if (cTrades.length > 100) cTrades.pop();
          console.log(`[CRYPTO BUY] ${pair} $${budget.toFixed(2)} @ $${price} | RSI(2)=${rsi.toFixed(1)} | target $${bb.mid.toFixed(2)} | deployed $${totalDeployed.toFixed(2)}/$${CRYPTO_MAX_TOTAL}`);
        } else {
          console.error(`[CRYPTO BUY FAILED] ${pair}:`, JSON.stringify(order).substring(0, 200));
        }
      }
    }
  } catch(e) { console.error("[Crypto tick error]:", e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now(), uptime: process.uptime() }));

app.get("/status", async (req, res) => {
  try {
    const [acct, posArr] = await Promise.all([aget("/v2/account"), aget("/v2/positions")]);
    const equity = parseFloat(acct.equity || 0);
    const positions = Array.isArray(posArr) ? posArr.map(x => ({
      symbol:   x.symbol,
      qty:      parseInt(x.qty),
      avgEntry: parseFloat(x.avg_entry_price || 0),
      price:    parseFloat(x.current_price || 0),
      pnl:      parseFloat(x.unrealized_pl || 0),
      pnlPct:   parseFloat(x.unrealized_plpc || 0) * 100,
      value:    parseFloat(x.market_value || 0),
      barsHeld: sPositionMeta[x.symbol]?.barsHeld || 0,
      market:   "stocks"
    })) : [];

    res.json({
      stockRunning, cryptoRunning, paper: PAPER,
      equity, cash: parseFloat(acct.cash || 0),
      buyingPow: parseFloat(acct.buying_power || 0),
      stockPnL:  parseFloat(sPnl.toFixed(2)),
      cryptoPnL: parseFloat(cPnl.toFixed(2)),
      totalPnL:  parseFloat((sPnl + cPnl).toFixed(2)),
      strategyInfo: {
        name:         "Mean Reversion — RSI(2) + Bollinger Bands",
        entry:        `RSI(2) < ${RSI_ENTRY} AND price below BB(${BB_PERIOD}) AND above MA(${TREND_MA_PERIOD})`,
        exit:         `MA reversion OR RSI(2) > ${RSI_EXIT} OR -${STOP_PCT*100}% stop OR ${TIME_STOP_BARS}-bar time stop`,
        riskPerTrade: `${(MAX_RISK_PCT*100).toFixed(0)}% of equity`,
        maxPositions: MAX_POSITIONS,
        minRR:        MIN_RR_RATIO
      },
      lossLimitStatus: {
        stockLossLimitHit, cryptoLossLimitHit,
        dailyTradesUsed: sDailyTradeCount, dailyTradesCap: MAX_DAILY_TRADES,
        dailyLossLimit:  dailyLossLimit === -Infinity ? null : parseFloat(dailyLossLimit.toFixed(2)),
        dailyLossUsed:   parseFloat(sPnl.toFixed(2))
      },
      cryptoBudget: {
        cap:       CRYPTO_MAX_TOTAL,
        lossLimit: parseFloat((CRYPTO_MAX_TOTAL * 0.30).toFixed(2)),
        pnl:       parseFloat(cPnl.toFixed(2)),
        resetDay:  lastCryptoResetDay
      },
      positions
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/pnl", (req, res) => {
  res.json(calcPnlStats([...sTrades, ...cTrades]));
});

app.get("/trades", (req, res) => {
  const period   = req.query.period || "today";
  const all      = [...sTrades, ...cTrades].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const now      = Date.now();
  const filtered = all.filter(t => {
    const d = new Date(t.date || now);
    if (period === "today") { const s = new Date(); s.setHours(0,0,0,0); return d >= s; }
    if (period === "week")  return now - d.getTime() <= 7 * 86400000;
    if (period === "month") { const s = new Date(); s.setDate(1); s.setHours(0,0,0,0); return d >= s; }
    return true;
  });
  res.json({ trades: filtered, count: filtered.length });
});

app.get("/signals", (req, res) => {
  res.json({ signals: [...sSigs, ...cSigs] });
});

app.get("/prices", (req, res) => {
  const stockBoard = STOCKS.map(sym => {
    const h     = sHistory[sym];
    const price = sPrices[sym] || null;
    const rsi   = h ? calcRSI(h.closes.slice(-20), RSI_PERIOD) : null;
    const bb    = h ? calcBB(h.closes, BB_PERIOD, BB_STD) : null;
    const ma200 = h ? calcSMA(h.closes, TREND_MA_PERIOD) : null;
    return {
      symbol:      sym, price,
      bars:        h?.count || 0,
      rsi:         rsi  ? parseFloat(rsi.toFixed(1))        : null,
      bbLower:     bb   ? parseFloat(bb.lower.toFixed(2))   : null,
      ma200:       ma200? parseFloat(ma200.toFixed(2))       : null,
      aboveTrend:  price && ma200 ? price > ma200 : null,
      ready:       (h?.count || 0) >= TREND_MA_PERIOD + 5
    };
  });
  const cryptoBoard = CRYPTO.map(pair => {
    const h   = cHistory[pair];
    const rsi = h ? calcRSI(h.closes.slice(-20), RSI_PERIOD) : null;
    const bb  = h ? calcBB(h.closes, BB_PERIOD, BB_STD) : null;
    const age = cPositionMeta[pair]?.entryTime
      ? parseFloat(((Date.now() - cPositionMeta[pair].entryTime) / 3600000).toFixed(1))
      : null;
    return {
      symbol:     pair,
      price:      cPrices[pair] || null,
      bars:       h?.count || 0,
      rsi:        rsi ? parseFloat(rsi.toFixed(1))      : null,
      bbLower:    bb  ? parseFloat(bb.lower.toFixed(2)) : null,
      bbMid:      bb  ? parseFloat(bb.mid.toFixed(2))   : null,
      entryPrice: cEntryPrice[pair] || null,
      ageHours:   age,
      ready:      (h?.count || 0) >= 30
    };
  });
  res.json({ stocks: stockBoard, crypto: cryptoBoard });
});

// Sell routes
app.post("/sell/all", async (req, res) => {
  try {
    const posArr = await aget("/v2/positions");
    if (!Array.isArray(posArr) || !posArr.length) return res.json({ ok: true, message: "No positions" });
    const results = [];
    for (const pos of posArr) {
      const sym = pos.symbol;
      const qty = Math.abs(parseInt(pos.qty));
      const ord = await apost("/v2/orders", { symbol: sym, qty, side: "sell", type: "market", time_in_force: "day" });
      if (ord.id) {
        const pv = parseFloat(pos.unrealized_pl || 0);
        sPnl += pv;
        sTrades.unshift({ id: ord.id, symbol: sym, side: "SELL", qty, price: parseFloat(pos.current_price || 0), pnl: pv, reason: "manual sell all", market: "stocks", date: new Date().toISOString(), time: new Date().toLocaleTimeString() });
        delete sPositionMeta[sym]; delete sEntryCount[sym];
        results.push(sym);
      }
    }
    res.json({ ok: true, sold: results });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/sell/:symbol", async (req, res) => {
  try {
    const sym    = req.params.symbol.toUpperCase();
    const posArr = await aget("/v2/positions");
    const pos    = Array.isArray(posArr) ? posArr.find(p => p.symbol === sym) : null;
    if (!pos) return res.json({ ok: false, error: "Position not found" });
    const qty = Math.abs(parseInt(pos.qty));
    const ord = await apost("/v2/orders", { symbol: sym, qty, side: "sell", type: "market", time_in_force: "day" });
    if (ord.id) {
      const pv = parseFloat(pos.unrealized_pl || 0);
      sPnl += pv;
      sTrades.unshift({ id: ord.id, symbol: sym, side: "SELL", qty, price: parseFloat(pos.current_price || 0), pnl: pv, reason: "manual", market: "stocks", date: new Date().toISOString(), time: new Date().toLocaleTimeString() });
      delete sPositionMeta[sym]; delete sEntryCount[sym];
      res.json({ ok: true, symbol: sym, qty, pnl: pv });
    } else {
      res.json({ ok: false, error: ord.message || "Order failed" });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Bot controls
app.all("/bot/start", (req, res) => {
  if (!stockRunning && !stockLossLimitHit) {
    stockRunning = true; stockTimer = setInterval(stockTick, 60000); stockTick();
    console.log("[BOT] Stock bot started");
  }
  if (!cryptoRunning && !cryptoLossLimitHit) {
    cryptoRunning = true; cTimer = setInterval(cryptoTick, 600000); cryptoTick();
    console.log("[BOT] Crypto bot started (24/7)");
  }
  res.json({ ok: true, stockRunning, cryptoRunning, stockLossLimitHit, cryptoLossLimitHit });
});
app.all("/bot/stop", (req, res) => {
  stockRunning = false; cryptoRunning = false;
  if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  if (cTimer)     { clearInterval(cTimer);     cTimer = null; }
  res.json({ ok: true, stockRunning, cryptoRunning });
});
app.all("/bot/start/stocks", (req, res) => {
  if (!stockRunning && !stockLossLimitHit) { stockRunning = true; stockTimer = setInterval(stockTick, 60000); stockTick(); }
  res.json({ ok: true, stockRunning, stockLossLimitHit });
});
app.all("/bot/stop/stocks", (req, res) => {
  stockRunning = false; if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  res.json({ ok: true, stockRunning });
});
app.all("/bot/start/crypto", (req, res) => {
  if (!cryptoRunning && !cryptoLossLimitHit) { cryptoRunning = true; cTimer = setInterval(cryptoTick, 600000); cryptoTick(); }
  res.json({ ok: true, cryptoRunning, cryptoLossLimitHit });
});
app.all("/bot/stop/crypto", (req, res) => {
  cryptoRunning = false; if (cTimer) { clearInterval(cTimer); cTimer = null; }
  res.json({ ok: true, cryptoRunning });
});

app.get("/cb/test", async (req, res) => {
  try {
    const jwt = makeCBJWT("GET", "/api/v3/brokerage/accounts");
    if (!jwt) return res.json({ ok: false, error: "JWT failed" });
    const data = await fetch(`${CB_BASE}/api/v3/brokerage/accounts`, {
      headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" }
    }).then(r => r.json());
    if (data.accounts) {
      res.json({
        ok: true,
        accounts: data.accounts
          .filter(a => parseFloat(a.available_balance?.value || 0) > 0 || a.currency === "USD")
          .map(a => ({ currency: a.currency, balance: a.available_balance?.value }))
      });
    } else {
      res.json({ ok: false, error: data.error });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ─── BOOT ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║        APEX TRADE v3.2 — MEAN REVERSION ENGINE          ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Strategy : RSI(2) + Bollinger Bands + 200MA filter     ║`);
  console.log(`║  Stocks   : 60s tick | market hours only | daily reset  ║`);
  console.log(`║  Crypto   : 10min tick | 24/7 | UTC midnight reset      ║`);
  console.log(`║  Risk     : ${(MAX_RISK_PCT*100).toFixed(0)}% equity/trade | max ${MAX_POSITIONS} pos | ${MAX_DAILY_TRADES} trades/day    ║`);
  console.log(`║  Sizing   : equity-scaled (auto-compounds with account) ║`);
  console.log(`║  Fix v3.2 : stock loss limit boot bug resolved          ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);

  await testCoinbaseAuth();

  // Auto-start both bots
  stockRunning = true;
  stockTimer   = setInterval(stockTick, 60000);
  stockTick();

  cryptoRunning = true;
  cTimer = setInterval(cryptoTick, 600000);
  cryptoTick();

  // Keep Render alive (pings every 10 min)
  setInterval(() => {
    fetch("https://apextrade-bot.onrender.com/ping").catch(() => {});
  }, 600000);

  // Watchdog — checks every hour, respects loss limit flags
  setInterval(() => {
    if (!stockRunning) {
      if (stockLossLimitHit) {
        console.log("[WATCHDOG] Stock — loss limit hit. Will NOT restart until tomorrow.");
      } else {
        console.log("[WATCHDOG] Restarting stock bot");
        stockRunning = true; stockTimer = setInterval(stockTick, 60000); stockTick();
      }
    }
    if (!cryptoRunning) {
      if (cryptoLossLimitHit) {
        console.log("[WATCHDOG] Crypto — loss limit hit. Will NOT restart until tomorrow.");
      } else {
        console.log("[WATCHDOG] Restarting crypto bot (24/7)");
        cryptoRunning = true; cTimer = setInterval(cryptoTick, 600000); cryptoTick();
      }
    }
  }, 3600000);
});
