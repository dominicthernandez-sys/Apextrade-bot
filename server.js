const express = require("express");
const path    = require("path");
const crypto  = require("crypto");
const app     = express();
app.use(express.json());
app.use(express.static(__dirname));

// ─── ENV CONFIG ───────────────────────────────────────────────────────────────
const AKEY        = process.env.ALPACA_KEY_ID;
const ASECRET     = process.env.ALPACA_SECRET_KEY;
const PAPER       = process.env.PAPER_TRADING !== "false";
const ABASE       = PAPER ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
const ADATA       = "https://data.alpaca.markets";
const AHDR        = { "APCA-API-KEY-ID": AKEY, "APCA-API-SECRET-KEY": ASECRET };
const DAILY_LOSS  = parseFloat(process.env.DAILY_LOSS_LIMIT || "-500");
const MAX_PER_STOCK = 2000;

// ─── CRYPTO BUDGET CONFIG ─────────────────────────────────────────────────────
const CRYPTO_MAX_TOTAL   = 100;
const CRYPTO_TRADE_PCT   = 0.15;
const CRYPTO_MIN_TRADE   = 2.00;
const CRYPTO_MAX_PER_SYM = 40;
const CRYPTO_FEE_PCT     = 0.006;
const CRYPTO_BREAKEVEN   = CRYPTO_FEE_PCT * 2 * 100; // 1.2%

// ─── COINBASE CONFIG ──────────────────────────────────────────────────────────
const CB_KEY_NAME        = process.env.COINBASE_KEY_NAME || "";
const CB_PRIVATE_KEY_RAW = (process.env.COINBASE_PRIVATE_KEY || "")
  .replace(/\\n/g, "\n").replace(/\r/g, "").trim();
const CB_BASE       = "https://api.coinbase.com";
const CB_KEY_IS_PEM = CB_PRIVATE_KEY_RAW.includes("-----BEGIN");

console.log("[BOOT] Alpaca paper:", PAPER);
console.log("[BOOT] CB key name:", CB_KEY_NAME ? CB_KEY_NAME.substring(0, 40) + "..." : "MISSING");
console.log("[BOOT] CB private key type:", CB_KEY_IS_PEM ? "PEM (ES256)" : "base64 blob (Ed25519)");
console.log("[BOOT] CB private key present:", !!CB_PRIVATE_KEY_RAW);
console.log(`[BOOT] Crypto budget: $${CRYPTO_MAX_TOTAL} cap | ${CRYPTO_TRADE_PCT * 100}% per trade | $${CRYPTO_MAX_PER_SYM} per symbol`);
console.log(`[BOOT] Fee breakeven: ${CRYPTO_BREAKEVEN.toFixed(2)}% | Signal threshold: 0.25% | MA window: 20`);

// ─── UNIVERSE ─────────────────────────────────────────────────────────────────
const STOCKS = [
  "SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META",
  "COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD","SOUN",
  "IONQ","RGTI","QUBT","ARM","AVGO","MU","CVNA","UBER","LYFT","DASH"
];
const CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD"];

// ─── STATE ────────────────────────────────────────────────────────────────────
let stockRunning = false, cryptoRunning = false;
let stockTimer = null, cTimer = null;
let lastResetDay = -1;

// ── FIX #1: Persistent loss-limit flags that survive watchdog restarts ─────────
// These are only cleared by maybeDailyReset(), NOT by the watchdog.
let stockLossLimitHit = false;
let cryptoLossLimitHit = false;

// Stock state
let sPnl = 0, sTrades = [], sSigs = [], sPrices = {}, sHist = {};
let sEntryCount = {}, sExitCount = {};

// ── FIX #4: Per-ticker cooldown map { SYM: expiry timestamp } ─────────────────
let sCooldown = {};

// ── FIX #7: Daily trade counter ───────────────────────────────────────────────
const MAX_DAILY_TRADES = 20;
let sDailyTradeCount = 0;

// ── FIX #6: Consecutive signal streak tracker ─────────────────────────────────
let sSigStreak = {}; // { SYM: count of consecutive BUY ticks }

// Crypto state
let cPnl = 0, cTrades = [], cSigs = [], cPrices = {}, cHist = {};
let cEntryCount = {}, cExitCount = {};
let cEntryPrice = {};
let cryptoBudgetDeployed = 0;

// ─── DAILY RESET ─────────────────────────────────────────────────────────────
function maybeDailyReset() {
  const now      = new Date();
  const day      = now.getUTCDay();
  const hour     = now.getUTCHours();
  const min      = now.getUTCMinutes();
  const todayNum = now.toISOString().slice(0, 10);

  if (day === 0 || day === 6) return;
  if (hour < 13 || (hour === 13 && min < 30)) return;
  if (lastResetDay === todayNum) return;

  lastResetDay = todayNum;

  // Stock reset
  sPnl = 0;
  sEntryCount = {};
  sExitCount = {};
  sDailyTradeCount = 0;   // FIX #7: reset daily trade counter
  sCooldown = {};          // FIX #4: clear all cooldowns on new day
  sSigStreak = {};         // FIX #6: clear signal streaks

  // ── FIX #1: Clear loss limit flags on new trading day ─────────────────────
  stockLossLimitHit = false;
  cryptoLossLimitHit = false;

  // Crypto reset
  cPnl = 0;
  cEntryCount = {};
  cExitCount = {};
  cEntryPrice = {};
  cryptoBudgetDeployed = 0;

  console.log("[RESET] Daily state reset for", todayNum);
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
    if (!CB_KEY_NAME || !CB_PRIVATE_KEY_RAW) {
      console.error("[CB JWT] Missing COINBASE_KEY_NAME or COINBASE_PRIVATE_KEY");
      return null;
    }
    const now   = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const headerObj  = { alg: CB_KEY_IS_PEM ? "ES256" : "EdDSA", kid: CB_KEY_NAME, nonce, typ: "JWT" };
    const payloadObj = {
      iss: "cdp", nbf: now, exp: now + 120, sub: CB_KEY_NAME,
      aud: ["cdp_service"],
      uri: `${method} api.coinbase.com${reqPath}`
    };
    const header  = Buffer.from(JSON.stringify(headerObj)).toString("base64url");
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    const msg     = `${header}.${payload}`;
    const msgBuf  = Buffer.from(msg);
    let sigBuf;
    if (CB_KEY_IS_PEM) {
      const key = crypto.createPrivateKey({ key: CB_PRIVATE_KEY_RAW, format: "pem" });
      sigBuf = crypto.sign(null, msgBuf, { key, dsaEncoding: "ieee-p1363", algorithm: "SHA256" });
    } else {
      const rawBytes = Buffer.from(CB_PRIVATE_KEY_RAW, "base64");
      if (rawBytes.length !== 64 && rawBytes.length !== 32) {
        console.error(`[CB JWT] Unexpected Ed25519 key length: ${rawBytes.length} bytes`);
        return null;
      }
      const seed        = rawBytes.slice(0, 32);
      const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
      const pkcs8Der    = Buffer.concat([pkcs8Header, seed]);
      const key = crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
      sigBuf = crypto.sign(null, msgBuf, key);
    }
    return `${msg}.${sigBuf.toString("base64url")}`;
  } catch (e) {
    console.error("[CB JWT] Signing error:", e.message);
    return null;
  }
}

// ─── TEST JWT ON BOOT ─────────────────────────────────────────────────────────
async function testCoinbaseAuth() {
  if (!CB_KEY_NAME || !CB_PRIVATE_KEY_RAW) {
    console.warn("[CB AUTH] Skipping test — keys not configured");
    return;
  }
  try {
    const testJwt = makeCBJWT("GET", "/api/v3/brokerage/accounts");
    if (!testJwt) { console.error("[CB AUTH] ❌ JWT generation failed"); return; }
    const res  = await fetch(`${CB_BASE}/api/v3/brokerage/accounts`, {
      headers: { "Authorization": `Bearer ${testJwt}`, "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (data.accounts) {
      console.log(`[CB AUTH] ✅ Coinbase auth OK — ${data.accounts.length} accounts`);
      data.accounts.forEach(a => {
        const bal = parseFloat(a.available_balance?.value || 0);
        if (bal > 0 || a.currency === "USD")
          console.log(`  [CB] ${a.currency}: $${bal.toFixed(2)}`);
      });
    } else {
      console.error("[CB AUTH] ❌ API error:", data.error, data.error_details || "");
    }
  } catch (e) {
    console.error("[CB AUTH] ❌ Test failed:", e.message);
  }
}

// ─── COINBASE HTTP HELPERS ────────────────────────────────────────────────────
function cbget(p) {
  const t = makeCBJWT("GET", p);
  if (!t) return Promise.resolve({ _jwtFailed: true });
  return fetch(CB_BASE + p, {
    headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" }
  })
    .then(async r => {
      const text = await r.text();
      try { return JSON.parse(text); }
      catch { console.error("[CB GET] Non-JSON:", text.substring(0, 500)); return {}; }
    })
    .catch(e => { console.error("[CB GET fetch]", e.message); return {}; });
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
    .then(data => {
      if (data.error || data.error_details)
        console.error("[CB POST]", p, JSON.stringify(data).substring(0, 200));
      return data;
    })
    .catch(e => { console.error("[CB POST fetch]", e.message); return {}; });
}

// ─── STOCK SIGNAL ENGINE ──────────────────────────────────────────────────────
// FIX #3: Extended to MA60 (10 minutes @ 10s polls) — much less noise than MA10.
// At 10s intervals, MA10 = 100s of context. MA60 = 600s (10 min). Far more meaningful.
function getStockSig(h) {
  if (!h || h.length < 60) return null;        // FIX #3: was < 10
  const window = h.slice(-60);                  // FIX #3: was slice(-10)
  const ma     = window.reduce((a, b) => a + b, 0) / 60;
  const c      = h[h.length - 1];
  const pct    = ((c - ma) / ma) * 100;

  if (pct > 0.15) return {
    type: "BUY",
    confidence: Math.min(99, Math.round(60 + pct * 8)),
    reason: `+${pct.toFixed(2)}% above MA60`
  };
  if (pct < -0.15) return {
    type: "SELL",
    confidence: Math.min(99, Math.round(60 + Math.abs(pct) * 8)),
    reason: `${pct.toFixed(2)}% below MA60`
  };
  return null;
}

// ─── CRYPTO SIGNAL ENGINE ─────────────────────────────────────────────────────
// MA20 @ 10s = ~3 min context. 0.25% threshold clears 1.2% fee breakeven.
function getCryptoSig(h) {
  if (!h || h.length < 20) return null;
  const window = h.slice(-20);
  const ma     = window.reduce((a, b) => a + b, 0) / 20;
  const c      = h[h.length - 1];
  const pct    = ((c - ma) / ma) * 100;

  if (pct > 0.25) return {
    type: "BUY",
    confidence: Math.min(99, Math.round(62 + pct * 12)),
    reason: `+${pct.toFixed(3)}% above MA20 (fee floor: ${CRYPTO_BREAKEVEN.toFixed(2)}%)`
  };
  if (pct < -0.25) return {
    type: "SELL",
    confidence: Math.min(99, Math.round(62 + Math.abs(pct) * 12)),
    reason: `${pct.toFixed(3)}% below MA20`
  };
  return null;
}

function addPx(hist, sym, price) {
  if (!hist[sym]) hist[sym] = [];
  const arr = hist[sym];
  if (!arr.length || arr[arr.length - 1] !== price) {
    arr.push(price);
    if (arr.length > 200) arr.shift(); // extended buffer to support MA60
  }
}

// ─── P&L STATS ───────────────────────────────────────────────────────────────
function calcPnlStats(tradeList) {
  const now        = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekStart  = new Date(); weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  function stats(list) {
    let total = 0, wins = 0, losses = 0;
    list.forEach(t => {
      if (t.pnl != null) {
        total += t.pnl;
        if (t.pnl > 0) wins++;
        else if (t.pnl < 0) losses++;
      }
    });
    return { total: parseFloat(total.toFixed(2)), wins, losses };
  }

  return {
    today: stats(tradeList.filter(t => new Date(t.date || now) >= todayStart)),
    week:  stats(tradeList.filter(t => new Date(t.date || now) >= weekStart)),
    month: stats(tradeList.filter(t => new Date(t.date || now) >= monthStart))
  };
}

// ─── IS MARKET OPEN ──────────────────────────────────────────────────────────
function isMarketHours() {
  const now  = new Date();
  const day  = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();
  const mins = hour * 60 + min;
  return mins >= 13 * 60 + 30 && mins < 20 * 60;
}

// ─── CRYPTO BUDGET HELPER ─────────────────────────────────────────────────────
async function getCryptoBudgetAvailable(cbAcc) {
  let deployed = 0;
  for (const pair of CRYPTO) {
    const coin    = pair.replace("-USD", "");
    const holding = parseFloat(cbAcc[coin]?.available_balance?.value || 0);
    const price   = cPrices[pair] || 0;
    deployed += holding * price;
  }
  const available = Math.max(0, CRYPTO_MAX_TOTAL - deployed);
  return { deployed: parseFloat(deployed.toFixed(2)), available: parseFloat(available.toFixed(2)) };
}

// ─── WEIGHTED AVERAGE ENTRY PRICE HELPER ──────────────────────────────────────
function updateEntryPrice(sym, prevHolding, prevAvg, addedUsd, newPrice) {
  const addedCoins = addedUsd / newPrice;
  const totalCoins = prevHolding + addedCoins;
  if (totalCoins <= 0) return newPrice;
  return ((prevHolding * prevAvg) + (addedCoins * newPrice)) / totalCoins;
}

// ─── STOCK TICK ───────────────────────────────────────────────────────────────
async function stockTick() {
  if (!stockRunning) return;
  maybeDailyReset();

  // FIX #1: Check loss limit using persistent flag — not just live sPnl
  if (sPnl <= DAILY_LOSS || stockLossLimitHit) {
    if (!stockLossLimitHit) {
      console.log("[STOCKS] Daily loss limit hit, pausing for the day.");
      stockLossLimitHit = true;
    }
    stockRunning = false;
    clearInterval(stockTimer);
    stockTimer = null;
    return;
  }

  if (!isMarketHours()) return;

  try {
    const snap = await dget("/v2/stocks/snapshots?symbols=" + STOCKS.join(",") + "&feed=iex");
    if (snap && typeof snap === "object") {
      Object.keys(snap).forEach(s => {
        const d = snap[s];
        const p = d?.latestTrade?.p || d?.minuteBar?.c || d?.dailyBar?.c;
        if (p) { sPrices[s] = p; addPx(sHist, s, p); }
      });
    }

    const posArr = await aget("/v2/positions");
    const posMap = {};
    if (Array.isArray(posArr)) posArr.forEach(p => { posMap[p.symbol] = p; });

    Object.keys(sEntryCount).forEach(s => {
      if (!posMap[s]) { sEntryCount[s] = 0; sExitCount[s] = 0; }
    });

    sSigs = [];

    for (const sym of STOCKS) {
      const price = sPrices[sym];
      if (!price) continue;

      const sig = getStockSig(sHist[sym]);

      // ── FIX #6: Track consecutive BUY signal streaks ───────────────────────
      if (sig?.type === "BUY") {
        sSigStreak[sym] = (sSigStreak[sym] || 0) + 1;
      } else {
        sSigStreak[sym] = 0;
      }

      if (!sig) continue;

      sSigs.push({
        symbol: sym, type: sig.type, confidence: sig.confidence,
        reason: sig.reason, price,
        streak: sSigStreak[sym] || 0,
        time: new Date().toLocaleTimeString(), market: "stocks"
      });

      // ── SELL LOGIC (existing positions take priority) ──────────────────────
      if (posMap[sym]) {
        const pos    = posMap[sym];
        const qty    = Math.abs(parseInt(pos.qty));
        const ep     = parseFloat(pos.avg_entry_price || price);
        const gp     = ((price - ep) / ep) * 100;
        const ageMs  = Date.now() - new Date(pos.created_at || Date.now()).getTime();
        const ageDays = ageMs / 86400000;
        const ageMin  = ageMs / 60000;   // FIX #2: track age in minutes

        if (!sExitCount[sym]) sExitCount[sym] = 0;
        const third = Math.max(1, Math.floor(qty / 3));

        let sell = false, sellQty = qty, why = "";

        // FIX #5: Stop-loss tightened from -15% to -5%
        if (gp <= -5) {
          sell = true; sellQty = qty; why = "stop-loss -5%";
          sEntryCount[sym] = 0; sExitCount[sym] = 0;

          // FIX #4: Apply 30-min cooldown on any stop-loss hit
          sCooldown[sym] = Date.now() + (30 * 60 * 1000);
          console.log(`[COOLDOWN] ${sym} blocked for 30min after stop-loss`);

        } else if (gp >= 35 && sExitCount[sym] < 3) {
          sell = true; sellQty = qty; why = "target +35% final";
          sEntryCount[sym] = 0; sExitCount[sym] = 0;

        } else if (gp >= 20 && sExitCount[sym] < 2) {
          sell = true; sellQty = third * 2; why = "scale-out +20%";
          sExitCount[sym] = 2;

        } else if (gp >= 10 && sExitCount[sym] < 1) {
          sell = true; sellQty = third; why = "scale-out +10%";
          sExitCount[sym] = 1;

        } else if (ageDays >= 5 && gp < 5) {
          sell = true; sellQty = qty; why = "5-day stale exit";
          sEntryCount[sym] = 0; sExitCount[sym] = 0;

        // FIX #2: Momentum sell now requires 15-min minimum hold + position must be losing
        } else if (sig.type === "SELL" && gp < 0 && ageMin >= 15) {
          sell = true; sellQty = qty; why = "momentum sell (held 15min+)";
          sEntryCount[sym] = 0; sExitCount[sym] = 0;

          // FIX #4: Apply 15-min cooldown after momentum sell at a loss
          if (gp < 0) {
            sCooldown[sym] = Date.now() + (15 * 60 * 1000);
            console.log(`[COOLDOWN] ${sym} blocked for 15min after momentum sell at loss`);
          }
        }

        if (sell && sellQty > 0) {
          const ratio = sellQty / qty;
          const ord = await apost("/v2/orders", {
            symbol: sym, qty: sellQty, side: "sell", type: "market", time_in_force: "day"
          });
          if (ord.id) {
            const sp = parseFloat(pos.unrealized_pl || 0) * ratio;
            sPnl += sp;
            sTrades.unshift({
              id: ord.id, symbol: sym, side: "SELL", qty: sellQty,
              price, pnl: sp, time: new Date().toLocaleTimeString(),
              strategy: why, market: "stocks", date: new Date().toISOString(),
              ageMin: Math.round(ageMin), gainPct: parseFloat(gp.toFixed(2))
            });
            if (sTrades.length > 200) sTrades.pop();
            console.log(`[SELL] ${sym} ${sellQty}sh | ${why} | P&L: $${sp.toFixed(2)} | held ${Math.round(ageMin)}min`);
          }
        }
        continue;
      }

      // ── BUY LOGIC ─────────────────────────────────────────────────────────
      if (sig.type === "BUY" && sig.confidence >= 65) {

        // FIX #4: Skip if ticker is in cooldown
        if (sCooldown[sym] && Date.now() < sCooldown[sym]) {
          const remaining = Math.round((sCooldown[sym] - Date.now()) / 60000);
          console.log(`[SKIP] ${sym} — cooldown active (${remaining}min remaining)`);
          continue;
        }

        // FIX #6: Require 2 consecutive BUY signals before entering
        if ((sSigStreak[sym] || 0) < 2) {
          console.log(`[SKIP] ${sym} — waiting for signal confirmation (streak: ${sSigStreak[sym] || 0}/2)`);
          continue;
        }

        // FIX #7: Hard cap on daily trade count
        if (sDailyTradeCount >= MAX_DAILY_TRADES) {
          console.log(`[SKIP] ${sym} — daily trade cap reached (${sDailyTradeCount}/${MAX_DAILY_TRADES})`);
          continue;
        }

        if (!sEntryCount[sym]) sEntryCount[sym] = 0;
        const maxEntries = sig.confidence >= 85 ? 3 : sig.confidence >= 75 ? 2 : 1;
        if (sEntryCount[sym] >= maxEntries) continue;

        const posVal = posMap[sym] ? parseFloat(posMap[sym].market_value || 0) : 0;
        const room   = MAX_PER_STOCK - posVal;
        if (room <= 50) continue;

        const entriesLeft = maxEntries - sEntryCount[sym];
        const budget = room / entriesLeft;
        const qty    = Math.max(1, Math.floor(budget / price));
        if (qty * price > room) continue;
        if (qty < 1) continue;

        // FIX #5: Stop price tightened to 5% below entry (was 15%)
        const stopPrice = parseFloat((price * 0.95).toFixed(2));

        const ord = await apost("/v2/orders", {
          symbol: sym, qty, side: "buy", type: "market", time_in_force: "day"
        });

        if (ord.id) {
          await apost("/v2/orders", {
            symbol: sym, qty, side: "sell", type: "stop",
            stop_price: stopPrice, time_in_force: "gtc"
          });
          sEntryCount[sym]++;
          sDailyTradeCount++;   // FIX #7: increment daily counter
          sTrades.unshift({
            id: ord.id, symbol: sym, side: "BUY", qty, price, pnl: null,
            time: new Date().toLocaleTimeString(),
            strategy: `Entry ${sEntryCount[sym]}/${maxEntries} ($${(qty * price).toFixed(0)}) streak:${sSigStreak[sym]}`,
            market: "stocks", date: new Date().toISOString()
          });
          if (sTrades.length > 200) sTrades.pop();
          console.log(`[BUY] ${sym} ${qty}sh @ $${price} | Entry ${sEntryCount[sym]}/${maxEntries} | $${(qty * price).toFixed(0)} | streak:${sSigStreak[sym]} | daily trades: ${sDailyTradeCount}/${MAX_DAILY_TRADES}`);
        }
      }
    }
  } catch (e) {
    console.error("[Stock tick error]:", e.message);
  }
}

// ─── CRYPTO TICK ──────────────────────────────────────────────────────────────
async function cryptoTick() {
  if (!cryptoRunning) return;
  maybeDailyReset();

  // FIX #1: Check persistent flag, not just live cPnl
  if (cPnl <= DAILY_LOSS || cryptoLossLimitHit) {
    if (!cryptoLossLimitHit) {
      console.log("[CRYPTO] Daily loss limit hit, pausing for the day.");
      cryptoLossLimitHit = true;
    }
    cryptoRunning = false;
    clearInterval(cTimer);
    cTimer = null;
    return;
  }

  try {
    // ── Fetch prices ──────────────────────────────────────────────────────────
    for (const pair of CRYPTO) {
      try {
        const res = await cbget(`/api/v3/brokerage/products/${pair}`);
        if (res?._jwtFailed) { console.warn("[CB price] JWT failed"); return; }
        const p = parseFloat(res?.price || res?.mid_market_price || 0);
        if (p > 0) { cPrices[pair] = p; addPx(cHist, pair, p); }
        else console.warn("[CB price]", pair, "no price in response");
      } catch (e) {
        console.error("[CB price fetch]", pair, e.message);
      }
    }

    // ── Fetch CB accounts ─────────────────────────────────────────────────────
    const accRes = await cbget("/api/v3/brokerage/accounts");
    const cbAcc  = {};
    if (accRes?.accounts) {
      accRes.accounts.forEach(a => { cbAcc[a.currency] = a; });
    }
    const usd = parseFloat(cbAcc["USD"]?.available_balance?.value || 0);

    // ── Budget check ──────────────────────────────────────────────────────────
    const { deployed, available } = await getCryptoBudgetAvailable(cbAcc);
    cryptoBudgetDeployed = deployed;

    cSigs = [];

    for (const sym of CRYPTO) {
      const price = cPrices[sym];
      if (!price) continue;

      const histLen = cHist[sym]?.length || 0;
      const sig = getCryptoSig(cHist[sym]);

      if (!sig) {
        if (histLen < 20) {
          console.log(`[CRYPTO SIG] ${sym} warming up — ${histLen}/20 samples (~${Math.round((20 - histLen) * 10 / 60)}min remaining)`);
        }
        continue;
      }

      // FIX #8: Always log when a signal is ready, even if blocked
      console.log(`[CRYPTO SIG READY] ${sym} | ${sig.type} | conf:${sig.confidence}% | gate:70 | deployed:$${deployed.toFixed(2)}/$${CRYPTO_MAX_TOTAL}`);

      cSigs.push({
        symbol: sym, type: sig.type, confidence: sig.confidence,
        reason: sig.reason, price, time: new Date().toLocaleTimeString(), market: "crypto"
      });

      const coin         = sym.replace("-USD", "");
      const holdingCoins = parseFloat(cbAcc[coin]?.available_balance?.value || 0);
      const symValue     = holdingCoins * price;

      // ── CRYPTO SELL ───────────────────────────────────────────────────────
      if (holdingCoins > 0) {
        if (!cExitCount[sym]) cExitCount[sym] = 0;

        const ep          = cEntryPrice[sym] || price;
        const gp          = ((price - ep) / ep) * 100;
        const gpAfterFees = gp - CRYPTO_BREAKEVEN;

        let why = "", sellAmt = null;

        if (gp <= -8) {
          why = `stop-loss -8% from entry $${ep.toFixed(2)}`;
          sellAmt = holdingCoins.toFixed(8);
          cEntryCount[sym] = 0; cExitCount[sym] = 0;
          delete cEntryPrice[sym]; delete cEntryPrice[sym + "_ts"];

        } else if (gp >= 20 && cExitCount[sym] < 3) {
          why = `target +20% final (net ~+${gpAfterFees.toFixed(1)}% after fees)`;
          sellAmt = holdingCoins.toFixed(8);
          cEntryCount[sym] = 0; cExitCount[sym] = 3;
          delete cEntryPrice[sym]; delete cEntryPrice[sym + "_ts"];

        } else if (gp >= 12 && cExitCount[sym] < 2) {
          why = `scale-out +12% (2/3 position)`;
          sellAmt = (holdingCoins * 2 / 3).toFixed(8);
          cExitCount[sym] = 2;

        } else if (gp >= 5 && cExitCount[sym] < 1) {
          why = `scale-out +5% (1/3 position)`;
          sellAmt = (holdingCoins / 3).toFixed(8);
          cExitCount[sym] = 1;

        } else if (cEntryPrice[sym]) {
          const ageMs  = Date.now() - (cEntryPrice[sym + "_ts"] || Date.now());
          const ageHrs = ageMs / 3600000;
          if (ageHrs >= 4 && gp < 1.5) {
            why = `stale exit — ${ageHrs.toFixed(1)}hr held, only ${gp.toFixed(2)}% gain`;
            sellAmt = holdingCoins.toFixed(8);
            cEntryCount[sym] = 0; cExitCount[sym] = 0;
            delete cEntryPrice[sym]; delete cEntryPrice[sym + "_ts"];
          }
        }

        if (!why && sig.type === "SELL" && gp < -2) {
          why = `momentum sell — ${gp.toFixed(2)}% from entry`;
          sellAmt = holdingCoins.toFixed(8);
          cEntryCount[sym] = 0; cExitCount[sym] = 0;
          delete cEntryPrice[sym]; delete cEntryPrice[sym + "_ts"];
        }

        if (why && sellAmt && parseFloat(sellAmt) * price >= CRYPTO_MIN_TRADE) {
          const sord = await cbpost("/api/v3/brokerage/orders", {
            client_order_id: crypto.randomUUID(),
            product_id: sym, side: "SELL",
            order_configuration: { market_market_ioc: { base_size: sellAmt } }
          });
          if (sord?.success) {
            const soldCoins = parseFloat(sellAmt);
            const grossPnl  = soldCoins * (price - (cEntryPrice[sym] || price));
            const feeCost   = soldCoins * price * CRYPTO_FEE_PCT;
            const netPnl    = grossPnl - feeCost;
            cPnl += netPnl;
            cTrades.unshift({
              id: sord.success_response?.order_id || Date.now().toString(),
              symbol: sym, side: "SELL", qty: sellAmt, price,
              pnl: parseFloat(netPnl.toFixed(2)), entryPrice: ep,
              time: new Date().toLocaleTimeString(),
              strategy: why, market: "crypto", date: new Date().toISOString()
            });
            if (cTrades.length > 100) cTrades.pop();
            console.log(`[CRYPTO SELL] ${sym} ${sellAmt} @ $${price} | ${why} | Net P&L: $${netPnl.toFixed(2)}`);
          } else if (sord?.error_response || sord?.error) {
            console.error(`[CRYPTO SELL FAILED] ${sym}:`, JSON.stringify(sord).substring(0, 200));
          }
        }
      }

      // ── CRYPTO BUY ────────────────────────────────────────────────────────
      if (sig.type === "BUY" && sig.confidence >= 70) {
        if (!cEntryCount[sym]) cEntryCount[sym] = 0;
        const maxE = sig.confidence >= 85 ? 3 : sig.confidence >= 78 ? 2 : 1;
        if (cEntryCount[sym] >= maxE) {
          console.log(`[CRYPTO BUY SKIP] ${sym} — max entries reached (${cEntryCount[sym]}/${maxE})`);
          continue;
        }

        if (available < CRYPTO_MIN_TRADE) {
          console.log(`[CRYPTO BUY SKIP] ${sym} — budget cap reached ($${deployed.toFixed(2)}/$${CRYPTO_MAX_TOTAL})`);
          continue;
        }
        if (symValue >= CRYPTO_MAX_PER_SYM) {
          console.log(`[CRYPTO BUY SKIP] ${sym} — per-symbol cap ($${symValue.toFixed(2)}/$${CRYPTO_MAX_PER_SYM})`);
          continue;
        }
        if (usd < CRYPTO_MIN_TRADE) {
          console.log(`[CRYPTO BUY SKIP] ${sym} — insufficient USD ($${usd.toFixed(2)})`);
          continue;
        }

        const symRoom    = CRYPTO_MAX_PER_SYM - symValue;
        const budgetBite = available * CRYPTO_TRADE_PCT;
        const budget     = Math.min(budgetBite, symRoom, usd);
        if (budget < CRYPTO_MIN_TRADE) continue;

        const order = await cbpost("/api/v3/brokerage/orders", {
          client_order_id: crypto.randomUUID(),
          product_id: sym, side: "BUY",
          order_configuration: { market_market_ioc: { quote_size: budget.toFixed(2) } }
        });

        if (order?.success) {
          const prevAvg     = cEntryPrice[sym] || price;
          const newEntryAvg = updateEntryPrice(sym, holdingCoins, prevAvg, budget, price);
          cEntryPrice[sym]       = newEntryAvg;
          cEntryPrice[sym + "_ts"] = cEntryPrice[sym + "_ts"] || Date.now();

          cEntryCount[sym]++;
          cTrades.unshift({
            id: order.success_response?.order_id || Date.now().toString(),
            symbol: sym, side: "BUY",
            qty: `$${budget.toFixed(2)}`, price, entryPrice: newEntryAvg, pnl: null,
            time: new Date().toLocaleTimeString(),
            strategy: `Entry ${cEntryCount[sym]}/${maxE} | conf:${sig.confidence}% | avg entry $${newEntryAvg.toFixed(2)}`,
            market: "crypto", date: new Date().toISOString()
          });
          if (cTrades.length > 100) cTrades.pop();
          console.log(`[CRYPTO BUY] ${sym} $${budget.toFixed(2)} @ $${price} | conf:${sig.confidence}% | avg entry $${newEntryAvg.toFixed(2)} | deployed $${(deployed + budget).toFixed(2)}/$${CRYPTO_MAX_TOTAL}`);
        } else if (order?.error_response || order?.error) {
          console.error(`[CRYPTO BUY FAILED] ${sym}:`, JSON.stringify(order).substring(0, 200));
        }
      }
    }
  } catch (e) {
    console.error("[Crypto tick error]:", e.message);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/cb/test", async (req, res) => {
  try {
    const jwt = makeCBJWT("GET", "/api/v3/brokerage/accounts");
    if (!jwt) return res.json({ ok: false, error: "JWT generation failed" });
    const data = await fetch(`${CB_BASE}/api/v3/brokerage/accounts`, {
      headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" }
    }).then(r => r.json());
    if (data.accounts) {
      const balances = data.accounts
        .filter(a => parseFloat(a.available_balance?.value || 0) > 0 || a.currency === "USD")
        .map(a => ({ currency: a.currency, balance: a.available_balance?.value }));
      res.json({ ok: true, accounts: balances });
    } else {
      res.json({ ok: false, error: data.error, detail: data.error_details || data.preview?.message });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/status", async (req, res) => {
  try {
    const [acct, posArr] = await Promise.all([aget("/v2/account"), aget("/v2/positions")]);
    const positions = Array.isArray(posArr)
      ? posArr.map(x => ({
          symbol:   x.symbol,
          qty:      parseInt(x.qty),
          avgEntry: parseFloat(x.avg_entry_price || 0),
          price:    parseFloat(x.current_price || 0),
          pnl:      parseFloat(x.unrealized_pl || 0),
          pnlPct:   parseFloat(x.unrealized_plpc || 0) * 100,
          value:    parseFloat(x.market_value || 0),
          market:   "stocks"
        }))
      : [];
    res.json({
      stockRunning, cryptoRunning, paper: PAPER,
      equity:    parseFloat(acct.equity || 0),
      cash:      parseFloat(acct.cash || 0),
      buyingPow: parseFloat(acct.buying_power || 0),
      stockPnL:  parseFloat(sPnl.toFixed(2)),
      cryptoPnL: parseFloat(cPnl.toFixed(2)),
      totalPnL:  parseFloat((sPnl + cPnl).toFixed(2)),
      dailyLossLimit: DAILY_LOSS,
      maxPerStock: MAX_PER_STOCK,
      // FIX #1: Expose loss limit flags in status
      lossLimitStatus: {
        stockLossLimitHit,
        cryptoLossLimitHit,
        dailyTradesUsed: sDailyTradeCount,
        dailyTradesCap: MAX_DAILY_TRADES
      },
      // FIX #4: Expose active cooldowns
      cooldowns: Object.fromEntries(
        Object.entries(sCooldown)
          .filter(([, exp]) => Date.now() < exp)
          .map(([sym, exp]) => [sym, Math.round((exp - Date.now()) / 60000) + "min"])
      ),
      cryptoConfig: {
        maWindow:        20,
        signalThreshold: "0.25%",
        confidenceGate:  70,
        feeBreakeven:    `${CRYPTO_BREAKEVEN.toFixed(2)}%`,
        universe:        CRYPTO
      },
      stockConfig: {
        maWindow:        60,
        signalThreshold: "0.15%",
        confidenceGate:  65,
        stopLoss:        "-5%",
        minHoldBeforeSell: "15min",
        maxDailyTrades:  MAX_DAILY_TRADES,
        consecutiveSignalsRequired: 2
      },
      cryptoBudget: {
        cap:       CRYPTO_MAX_TOTAL,
        deployed:  cryptoBudgetDeployed,
        available: parseFloat((CRYPTO_MAX_TOTAL - cryptoBudgetDeployed).toFixed(2))
      },
      cryptoEntryPrices: Object.fromEntries(
        CRYPTO.map(s => [s, cEntryPrice[s] ? parseFloat(cEntryPrice[s].toFixed(2)) : null])
      ),
      positions
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/pnl", (req, res) => {
  const all = [...sTrades, ...cTrades];
  res.json(calcPnlStats(all));
});

app.get("/trades", (req, res) => {
  const period = req.query.period || "today";
  const all    = [...sTrades, ...cTrades]
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const now    = Date.now();
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
  const stockBoard = STOCKS.map(sym => ({
    symbol: sym, price: sPrices[sym] || null,
    histLen: sHist[sym]?.length || 0,
    warmupPct: Math.min(100, Math.round(((sHist[sym]?.length || 0) / 60) * 100)),
    streak: sSigStreak[sym] || 0,
    cooldown: sCooldown[sym] && Date.now() < sCooldown[sym]
      ? Math.round((sCooldown[sym] - Date.now()) / 60000) + "min"
      : null
  }));
  const cryptoBoard = CRYPTO.map(sym => ({
    symbol:     sym,
    price:      cPrices[sym] || null,
    histLen:    cHist[sym]?.length || 0,
    warmupPct:  Math.min(100, Math.round(((cHist[sym]?.length || 0) / 20) * 100)),
    entryPrice: cEntryPrice[sym] ? parseFloat(cEntryPrice[sym].toFixed(2)) : null,
    entryAge:   cEntryPrice[sym + "_ts"]
      ? Math.round((Date.now() - cEntryPrice[sym + "_ts"]) / 60000) + "min"
      : null
  }));
  res.json({ stocks: stockBoard, crypto: cryptoBoard, raw: { ...sPrices, ...cPrices } });
});

// ─── SELL ROUTES ──────────────────────────────────────────────────────────────
app.post("/sell/all", async (req, res) => {
  try {
    const posArr = await aget("/v2/positions");
    if (!Array.isArray(posArr) || posArr.length === 0)
      return res.json({ ok: true, message: "No positions to sell" });
    const results = [];
    for (const pos of posArr) {
      const sym = pos.symbol;
      const qty = Math.abs(parseInt(pos.qty));
      const ord = await apost("/v2/orders", { symbol: sym, qty, side: "sell", type: "market", time_in_force: "day" });
      if (ord.id) {
        const pv = parseFloat(pos.unrealized_pl || 0);
        sPnl += pv;
        sTrades.unshift({
          id: ord.id, symbol: sym, side: "SELL", qty,
          price: parseFloat(pos.current_price || 0), pnl: pv,
          time: new Date().toLocaleTimeString(), strategy: "manual sell all",
          market: "stocks", date: new Date().toISOString()
        });
        sEntryCount[sym] = 0; sExitCount[sym] = 0;
        results.push(sym);
      }
    }
    res.json({ ok: true, sold: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
      sTrades.unshift({
        id: ord.id, symbol: sym, side: "SELL", qty,
        price: parseFloat(pos.current_price || 0), pnl: pv,
        time: new Date().toLocaleTimeString(), strategy: "manual",
        market: "stocks", date: new Date().toISOString()
      });
      sEntryCount[sym] = 0; sExitCount[sym] = 0;
      res.json({ ok: true, symbol: sym, qty, pnl: pv });
    } else {
      res.json({ ok: false, error: ord.message || "Order failed" });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Manual cooldown override (admin) ──────────────────────────────────────────
app.post("/cooldown/clear/:symbol", (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  delete sCooldown[sym];
  res.json({ ok: true, message: `Cooldown cleared for ${sym}` });
});

app.post("/cooldown/clear", (req, res) => {
  sCooldown = {};
  res.json({ ok: true, message: "All cooldowns cleared" });
});

// ─── BOT CONTROLS ─────────────────────────────────────────────────────────────
app.all("/bot/start", (req, res) => {
  // FIX #1: Don't restart if loss limit was hit today
  if (!stockRunning && !stockLossLimitHit) {
    stockRunning = true;
    stockTimer = setInterval(stockTick, 10000);
    stockTick();
    console.log("[BOT] Stock bot started");
  } else if (stockLossLimitHit) {
    console.log("[BOT] Stock bot NOT started — daily loss limit already hit today");
  }
  if (!cryptoRunning && !cryptoLossLimitHit) {
    cryptoRunning = true;
    cTimer = setInterval(cryptoTick, 10000);
    cryptoTick();
    console.log("[BOT] Crypto bot started");
  } else if (cryptoLossLimitHit) {
    console.log("[BOT] Crypto bot NOT started — daily loss limit already hit today");
  }
  res.json({
    ok: true, stockRunning, cryptoRunning,
    stockLossLimitHit, cryptoLossLimitHit
  });
});

app.all("/bot/stop", (req, res) => {
  stockRunning = false;
  cryptoRunning = false;
  if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  if (cTimer)     { clearInterval(cTimer);     cTimer = null; }
  console.log("[BOT] All bots stopped");
  res.json({ ok: true, stockRunning, cryptoRunning });
});

app.all("/bot/start/stocks", (req, res) => {
  if (!stockRunning && !stockLossLimitHit) {
    stockRunning = true;
    stockTimer = setInterval(stockTick, 10000);
    stockTick();
  }
  res.json({ ok: true, stockRunning, stockLossLimitHit });
});

app.all("/bot/stop/stocks", (req, res) => {
  stockRunning = false;
  if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  res.json({ ok: true, stockRunning });
});

app.all("/bot/start/crypto", (req, res) => {
  if (!cryptoRunning && !cryptoLossLimitHit) {
    cryptoRunning = true;
    cTimer = setInterval(cryptoTick, 10000);
    cryptoTick();
  }
  res.json({ ok: true, cryptoRunning, cryptoLossLimitHit });
});

app.all("/bot/stop/crypto", (req, res) => {
  cryptoRunning = false;
  if (cTimer) { clearInterval(cTimer); cTimer = null; }
  res.json({ ok: true, cryptoRunning });
});

app.get("/cb/products", async (req, res) => {
  try {
    const data = await cbget("/api/v3/brokerage/products?limit=250");
    if (!data.products) return res.json({ raw: data });
    const cryptoSymbols = ["BTC","ETH","SOL"];
    const matches = data.products
      .filter(p => cryptoSymbols.some(c => p.product_id.startsWith(c)))
      .map(p => ({ id: p.product_id, price: p.price, status: p.status }));
    res.json({ matches, total: data.products.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ─── BOOT ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║           APEX TRADE v2 — SERVER STARTED            ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  Port: ${PORT}  |  Paper: ${PAPER}                          ║`);
  console.log(`║  STOCKS: MA60 | 0.15% threshold | 65% gate          ║`);
  console.log(`║  STOCKS: Stop -5% | Min hold 15min | 2x confirm     ║`);
  console.log(`║  STOCKS: Max ${MAX_DAILY_TRADES} trades/day | 15-30min cooldown   ║`);
  console.log(`║  CRYPTO: MA20 | 0.25% threshold | 70% gate          ║`);
  console.log(`║  CRYPTO: Fee breakeven: ${CRYPTO_BREAKEVEN.toFixed(2)}% per round-trip       ║`);
  console.log(`║  CRYPTO: Stop -8% | Targets +5% / +12% / +20%      ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  await testCoinbaseAuth();

  stockRunning = true;
  stockTimer   = setInterval(stockTick, 10000);
  stockTick();

  cryptoRunning = true;
  cTimer = setInterval(cryptoTick, 10000);
  cryptoTick();

  // Keep Render alive
  setInterval(() => {
    fetch("https://apextrade-bot.onrender.com/ping").catch(() => {});
  }, 600000);

  // ── FIX #1: Watchdog now checks loss limit flags before restarting ─────────
  setInterval(() => {
    if (!stockRunning) {
      if (stockLossLimitHit) {
        console.log("[WATCHDOG] Stock bot stopped — daily loss limit hit. Will NOT restart until tomorrow.");
      } else {
        console.log("[WATCHDOG] Restarting stock bot");
        stockRunning = true;
        stockTimer   = setInterval(stockTick, 10000);
        stockTick();
      }
    }
    if (!cryptoRunning) {
      if (cryptoLossLimitHit) {
        console.log("[WATCHDOG] Crypto bot stopped — daily loss limit hit. Will NOT restart until tomorrow.");
      } else {
        console.log("[WATCHDOG] Restarting crypto bot");
        cryptoRunning = true;
        cTimer = setInterval(cryptoTick, 10000);
        cryptoTick();
      }
    }
  }, 3600000);
});
