const express = require("express");
const path = require("path");
const crypto = require("crypto");
const app = express();
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

// ─── COINBASE CONFIG ──────────────────────────────────────────────────────────
// Your CB_KEY_NAME should look like: "organizations/ORG_ID/apiKeys/KEY_ID"
// Your CB_PRIVATE_KEY should be the full PEM including -----BEGIN EC PRIVATE KEY-----
// OR the raw base64 of the 64-byte Ed25519 key (32-byte seed + 32-byte pubkey)
const CB_KEY_NAME    = process.env.COINBASE_KEY_NAME || "";
const CB_PRIVATE_KEY_RAW = (process.env.COINBASE_PRIVATE_KEY || "")
  .replace(/\\n/g, "\n")
  .replace(/\r/g, "")
  .trim();
const CB_BASE = "https://api.coinbase.com";

// ─── DETECT KEY TYPE ──────────────────────────────────────────────────────────
// CDP keys can be Ed25519 (base64 blob) or EC P-256 (PEM). Detect which we have.
const CB_KEY_IS_PEM = CB_PRIVATE_KEY_RAW.includes("-----BEGIN");

console.log("[BOOT] Alpaca paper:", PAPER);
console.log("[BOOT] CB key name:", CB_KEY_NAME ? CB_KEY_NAME.substring(0, 40) + "..." : "MISSING");
console.log("[BOOT] CB private key type:", CB_KEY_IS_PEM ? "PEM (ES256)" : "base64 blob (Ed25519/ES256)");
console.log("[BOOT] CB private key present:", !!CB_PRIVATE_KEY_RAW);

// ─── UNIVERSE ─────────────────────────────────────────────────────────────────
const STOCKS = [
  "SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META",
  "COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD","SOUN",
  "IONQ","RGTI","QUBT","ARM","AVGO","MU","CVNA","UBER","LYFT","DASH"
];
const CRYPTO = ["BTC-USD","ETH-USD","SOL-USD","DOGE-USD","ADA-USD"];

// ─── STATE ────────────────────────────────────────────────────────────────────
let stockRunning = false, cryptoRunning = false;
let stockTimer = null, cTimer = null;
let lastResetDay = -1;

// Stock state
let sPnl = 0, sTrades = [], sSigs = [], sPrices = {}, sHist = {};
let sEntryCount = {}, sExitCount = {};

// Crypto state
let cPnl = 0, cTrades = [], cSigs = [], cPrices = {}, cHist = {};
let cEntryCount = {}, cExitCount = {};

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
  sPnl = 0; sEntryCount = {}; sExitCount = {};
  cPnl = 0; cEntryCount = {}; cExitCount = {};
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
// Supports both key types that CDP issues:
//   1. Ed25519 keys  → raw 64-byte base64 blob (no PEM headers)
//   2. EC P-256 keys → full PEM string (-----BEGIN EC PRIVATE KEY-----)
//
// How to identify your key type in the CDP portal:
//   - If the key was created with "Ed25519" algorithm selected → use type 1
//   - If the key was created with "ES256" / "ECDSA" selected  → use type 2
//
// Set COINBASE_PRIVATE_KEY env var to the raw value from the portal (no extra escaping needed).
// Set COINBASE_KEY_NAME to the full key name: "organizations/ORG/apiKeys/KEY_ID"

function makeCBJWT(method, reqPath) {
  try {
    if (!CB_KEY_NAME || !CB_PRIVATE_KEY_RAW) {
      console.error("[CB JWT] Missing COINBASE_KEY_NAME or COINBASE_PRIVATE_KEY");
      return null;
    }

    const now   = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");

    const headerObj = { alg: CB_KEY_IS_PEM ? "ES256" : "EdDSA", kid: CB_KEY_NAME, nonce, typ: "JWT" };
    const payloadObj = {
      iss: "cdp",
      nbf: now,
      exp: now + 120,
      sub: CB_KEY_NAME,
      aud: ["cdp_service"],
      uri: `${method} api.coinbase.com${reqPath}`
    };

    const header  = Buffer.from(JSON.stringify(headerObj)).toString("base64url");
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    const msg     = `${header}.${payload}`;
    const msgBuf  = Buffer.from(msg);

    let sigBuf;

    if (CB_KEY_IS_PEM) {
      // ── ES256 path: PEM key (EC P-256) ────────────────────────────────────
      // This handles keys that look like:
      //   -----BEGIN EC PRIVATE KEY-----
      //   ...base64...
      //   -----END EC PRIVATE KEY-----
      const key = crypto.createPrivateKey({
        key: CB_PRIVATE_KEY_RAW,
        format: "pem"
      });
      sigBuf = crypto.sign(null, msgBuf, {
        key,
        dsaEncoding: "ieee-p1363",  // Required: compact R||S format for JWT
        algorithm: "SHA256"
      });
    } else {
      // ── EdDSA path: raw base64 Ed25519 key ────────────────────────────────
      // CDP Ed25519 keys are a 64-byte blob: first 32 bytes = seed, last 32 = public key
      // Node.js crypto.sign with Ed25519 needs the key as a KeyObject
      const rawBytes = Buffer.from(CB_PRIVATE_KEY_RAW, "base64");

      if (rawBytes.length !== 64) {
        // Some CDP portals export just the 32-byte seed — handle both
        if (rawBytes.length !== 32) {
          console.error(`[CB JWT] Unexpected Ed25519 key length: ${rawBytes.length} bytes (expected 32 or 64)`);
          return null;
        }
      }

      // Node requires the key in DER/PKCS8 format for Ed25519.
      // We build it manually: PKCS8 header (16 bytes) + 32-byte seed
      const seed = rawBytes.slice(0, 32);
      const pkcs8Header = Buffer.from(
        "302e020100300506032b657004220420", "hex"
      ); // standard PKCS8 prefix for Ed25519
      const pkcs8Der = Buffer.concat([pkcs8Header, seed]);

      const key = crypto.createPrivateKey({
        key: pkcs8Der,
        format: "der",
        type: "pkcs8"
      });

      // Ed25519 sign — no hash algorithm needed (it's built in)
      sigBuf = crypto.sign(null, msgBuf, key);
    }

    return `${msg}.${sigBuf.toString("base64url")}`;

  } catch (e) {
    console.error("[CB JWT] Signing error:", e.message);
    // Detailed help for common errors:
    if (e.message.includes("error:0906D06C") || e.message.includes("PEM")) {
      console.error("[CB JWT] Key format issue. Check that COINBASE_PRIVATE_KEY is the exact PEM or base64 from the CDP portal.");
    }
    if (e.message.includes("Invalid key length")) {
      console.error("[CB JWT] Ed25519 key blob is the wrong length. It should decode to 32 or 64 bytes.");
    }
    return null;
  }
}

// ─── TEST JWT ON BOOT ─────────────────────────────────────────────────────────
// Runs once at startup so you see immediately in logs if auth works
async function testCoinbaseAuth() {
  if (!CB_KEY_NAME || !CB_PRIVATE_KEY_RAW) {
    console.warn("[CB AUTH] Skipping test — keys not configured");
    return;
  }
  try {
    console.log("[CB AUTH] Testing JWT generation...");
    const testJwt = makeCBJWT("GET", "/api/v3/brokerage/accounts");
    if (!testJwt) {
      console.error("[CB AUTH] ❌ JWT generation failed — check key format");
      return;
    }
    console.log("[CB AUTH] JWT generated OK, testing API call...");
    const res = await fetch(`${CB_BASE}/api/v3/brokerage/accounts`, {
      headers: { "Authorization": `Bearer ${testJwt}`, "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (data.accounts) {
      console.log(`[CB AUTH] ✅ Coinbase auth working — ${data.accounts.length} accounts found`);
      data.accounts.forEach(a => {
        const bal = parseFloat(a.available_balance?.value || 0);
        if (bal > 0 || a.currency === "USD") {
          console.log(`  [CB] ${a.currency}: $${bal.toFixed(2)}`);
        }
      });
    } else if (data.error) {
      console.error("[CB AUTH] ❌ API error:", data.error, data.error_details || data.preview?.message || "");
      console.error("[CB AUTH] Full response:", JSON.stringify(data).substring(0, 300));
    } else {
      console.warn("[CB AUTH] ⚠️  Unexpected response:", JSON.stringify(data).substring(0, 200));
    }
  } catch (e) {
    console.error("[CB AUTH] ❌ Test request failed:", e.message);
  }
}

// ─── COINBASE HTTP HELPERS ────────────────────────────────────────────────────
function cbget(p) {
  const t = makeCBJWT("GET", p);
  if (!t) return Promise.resolve({ _jwtFailed: true });
  return fetch(CB_BASE + p, {
    headers: { "Authorization": `Bearer ${t}`, "Content-Type": "application/json" }
  })
    .then(r => r.json())
    .then(data => {
      if (data.error || data.error_details) {
        console.error("[CB GET]", p, JSON.stringify(data).substring(0, 200));
      }
      return data;
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
      if (data.error || data.error_details) {
        console.error("[CB POST]", p, JSON.stringify(data).substring(0, 200));
      }
      return data;
    })
    .catch(e => { console.error("[CB POST fetch]", e.message); return {}; });
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────
function getSig(h) {
  if (!h || h.length < 10) return null;
  const window = h.slice(-10);
  const ma  = window.reduce((a, b) => a + b, 0) / 10;
  const c   = h[h.length - 1];
  const pct = ((c - ma) / ma) * 100;

  if (pct > 0.15) return {
    type: "BUY",
    confidence: Math.min(99, Math.round(60 + pct * 8)),
    reason: `+${pct.toFixed(2)}% above MA10`
  };
  if (pct < -0.15) return {
    type: "SELL",
    confidence: Math.min(99, Math.round(60 + Math.abs(pct) * 8)),
    reason: `${pct.toFixed(2)}% below MA10`
  };
  return null;
}

function addPx(hist, sym, price) {
  if (!hist[sym]) hist[sym] = [];
  const arr = hist[sym];
  if (!arr.length || arr[arr.length - 1] !== price) {
    arr.push(price);
    if (arr.length > 50) arr.shift();
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

// ─── STOCK TICK ───────────────────────────────────────────────────────────────
async function stockTick() {
  if (!stockRunning) return;
  maybeDailyReset();

  if (sPnl <= DAILY_LOSS) {
    console.log("[STOCKS] Daily loss limit hit, pausing.");
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

      const sig = getSig(sHist[sym]);
      if (!sig) continue;

      sSigs.push({
        symbol: sym, type: sig.type, confidence: sig.confidence,
        reason: sig.reason, price, time: new Date().toLocaleTimeString(), market: "stocks"
      });

      if (posMap[sym]) {
        const pos    = posMap[sym];
        const qty    = Math.abs(parseInt(pos.qty));
        const ep     = parseFloat(pos.avg_entry_price || price);
        const gp     = ((price - ep) / ep) * 100;
        const ageMs  = Date.now() - new Date(pos.created_at || Date.now()).getTime();
        const ageDays = ageMs / 86400000;

        if (!sExitCount[sym]) sExitCount[sym] = 0;
        const third = Math.max(1, Math.floor(qty / 3));

        let sell = false, sellQty = qty, why = "";

        if (gp <= -15) {
          sell = true; sellQty = qty; why = "stop-loss -15%";
          sEntryCount[sym] = 0; sExitCount[sym] = 0;
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
        } else if (sig.type === "SELL" && gp < 0) {
          sell = true; sellQty = qty; why = "momentum sell";
          sEntryCount[sym] = 0; sExitCount[sym] = 0;
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
              strategy: why, market: "stocks", date: new Date().toISOString()
            });
            if (sTrades.length > 200) sTrades.pop();
            console.log(`[SELL] ${sym} ${sellQty}sh | ${why} | P&L: $${sp.toFixed(2)}`);
          }
        }
        continue;
      }

      if (sig.type === "BUY" && sig.confidence >= 65) {
        if (!sEntryCount[sym]) sEntryCount[sym] = 0;
        const maxEntries = sig.confidence >= 85 ? 3 : sig.confidence >= 75 ? 2 : 1;
        if (sEntryCount[sym] >= maxEntries) continue;

        const acct   = await aget("/v2/account");
        const posVal = posMap[sym] ? parseFloat(posMap[sym].market_value || 0) : 0;
        const room   = MAX_PER_STOCK - posVal;
        if (room <= 50) continue;

        const entriesLeft = maxEntries - sEntryCount[sym];
        const budget = room / entriesLeft;
        const qty    = Math.max(1, Math.floor(budget / price));
        if (qty * price > room) continue;
        if (qty < 1) continue;

        const stopPrice = parseFloat((price * 0.85).toFixed(2));
        const ord = await apost("/v2/orders", {
          symbol: sym, qty, side: "buy", type: "market", time_in_force: "day"
        });

        if (ord.id) {
          await apost("/v2/orders", {
            symbol: sym, qty, side: "sell", type: "stop",
            stop_price: stopPrice, time_in_force: "gtc"
          });
          sEntryCount[sym]++;
          sTrades.unshift({
            id: ord.id, symbol: sym, side: "BUY", qty, price, pnl: null,
            time: new Date().toLocaleTimeString(),
            strategy: `Entry ${sEntryCount[sym]}/${maxEntries} ($${(qty * price).toFixed(0)})`,
            market: "stocks", date: new Date().toISOString()
          });
          if (sTrades.length > 200) sTrades.pop();
          console.log(`[BUY] ${sym} ${qty}sh @ $${price} | Entry ${sEntryCount[sym]}/${maxEntries} | $${(qty * price).toFixed(0)}`);
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

  if (cPnl <= DAILY_LOSS) {
    console.log("[CRYPTO] Daily loss limit hit, pausing.");
    cryptoRunning = false;
    clearInterval(cTimer);
    cTimer = null;
    return;
  }

  try {
    // ── Fetch prices via Coinbase best bid/ask ──
    for (const pair of CRYPTO) {
      try {
        const res = await cbget(`/api/v3/brokerage/best_bid_ask?product_ids=${pair}`);
        if (res?._jwtFailed) {
          console.warn("[CB price] JWT failed — skipping crypto tick");
          return;
        }
        if (res?.pricebooks?.length > 0) {
          const pb = res.pricebooks[0];
          const p  = parseFloat(pb.asks?.[0]?.price || pb.bids?.[0]?.price || 0);
          if (p > 0) { cPrices[pair] = p; addPx(cHist, pair, p); }
        } else if (res && !res.pricebooks) {
          console.warn("[CB price]", pair, "unexpected response:", JSON.stringify(res).substring(0, 150));
        }
      } catch (e) {
        console.error("[CB price fetch]", pair, e.message);
      }
    }

    // ── Fetch CB accounts ──
    const accRes = await cbget("/api/v3/brokerage/accounts");
    const cbAcc  = {};
    if (accRes?.accounts) {
      accRes.accounts.forEach(a => { cbAcc[a.currency] = a; });
    }
    const usd = parseFloat(cbAcc["USD"]?.available_balance?.value || 0);

    // ── Generate signals & trade ──
    cSigs = [];

    for (const sym of CRYPTO) {
      const price = cPrices[sym];
      if (!price) continue;

      const sig = getSig(cHist[sym]);
      if (!sig) continue;

      cSigs.push({
        symbol: sym, type: sig.type, confidence: sig.confidence,
        reason: sig.reason, price, time: new Date().toLocaleTimeString(), market: "crypto"
      });

      // ── CRYPTO BUY ──
      if (sig.type === "BUY" && sig.confidence >= 75) {
        if (!cEntryCount[sym]) cEntryCount[sym] = 0;
        const maxE = sig.confidence >= 85 ? 3 : 2;
        if (cEntryCount[sym] >= maxE) continue;

        const entriesLeft = maxE - cEntryCount[sym];
        const budget = (usd * 0.10) / entriesLeft;
        if (budget < 1 || usd < 5) continue;

        const coin    = sym.replace("-USD", "");
        const holding = parseFloat(cbAcc[coin]?.available_balance?.value || 0);
        if (holding * price > MAX_PER_STOCK) continue;

        const order = await cbpost("/api/v3/brokerage/orders", {
          client_order_id: crypto.randomUUID(),
          product_id: sym,
          side: "BUY",
          order_configuration: { market_market_ioc: { quote_size: budget.toFixed(2) } }
        });

        if (order?.success) {
          cEntryCount[sym]++;
          cTrades.unshift({
            id: order.success_response?.order_id || Date.now().toString(),
            symbol: sym, side: "BUY", qty: `$${budget.toFixed(2)}`, price, pnl: null,
            time: new Date().toLocaleTimeString(),
            strategy: `Crypto Entry ${cEntryCount[sym]}/${maxE}`,
            market: "crypto", date: new Date().toISOString()
          });
          if (cTrades.length > 100) cTrades.pop();
          console.log(`[CRYPTO BUY] ${sym} $${budget.toFixed(2)} @ $${price}`);
        } else if (order?.error_response || order?.error) {
          console.error(`[CRYPTO BUY FAILED] ${sym}:`, JSON.stringify(order).substring(0, 200));
        }
      }

      // ── CRYPTO SELL ──
      if (sig.type === "SELL" && sig.confidence >= 75) {
        const coin = sym.replace("-USD", "");
        const holding = parseFloat(cbAcc[coin]?.available_balance?.value || 0);
        if (holding <= 0) continue;
        if (!cExitCount[sym]) cExitCount[sym] = 0;

        const oldest = cHist[sym]?.[0] || price;
        const gp     = ((price - oldest) / oldest) * 100;

        let why = "";
        let sellAmt = null;

        if (gp <= -15) {
          why = "stop-loss -15%";
          sellAmt = holding.toFixed(8);
          cEntryCount[sym] = 0; cExitCount[sym] = 0;
        } else if (gp >= 35 && cExitCount[sym] < 3) {
          why = "target +35% final";
          sellAmt = holding.toFixed(8);
          cEntryCount[sym] = 0; cExitCount[sym] = 3;
        } else if (gp >= 20 && cExitCount[sym] < 2) {
          why = "scale-out +20%";
          sellAmt = (holding / 3 * 2).toFixed(8);
          cExitCount[sym] = 2;
        } else if (gp >= 10 && cExitCount[sym] < 1) {
          why = "scale-out +10%";
          sellAmt = (holding / 3).toFixed(8);
          cExitCount[sym] = 1;
        }

        if (!why || !sellAmt) continue;
        if (parseFloat(sellAmt) * price < 1) continue;

        const sord = await cbpost("/api/v3/brokerage/orders", {
          client_order_id: crypto.randomUUID(),
          product_id: sym,
          side: "SELL",
          order_configuration: { market_market_ioc: { base_size: sellAmt } }
        });

        if (sord?.success) {
          const sp = parseFloat(sellAmt) * price * (gp / 100);
          cPnl += sp;
          cTrades.unshift({
            id: sord.success_response?.order_id || Date.now().toString(),
            symbol: sym, side: "SELL", qty: sellAmt, price, pnl: parseFloat(sp.toFixed(2)),
            time: new Date().toLocaleTimeString(),
            strategy: why, market: "crypto", date: new Date().toISOString()
          });
          if (cTrades.length > 100) cTrades.pop();
          console.log(`[CRYPTO SELL] ${sym} ${sellAmt} | ${why} | P&L: $${sp.toFixed(2)}`);
        } else if (sord?.error_response || sord?.error) {
          console.error(`[CRYPTO SELL FAILED] ${sym}:`, JSON.stringify(sord).substring(0, 200));
        }
      }
    }
  } catch (e) {
    console.error("[Crypto tick error]:", e.message);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));

// Debug route — test Coinbase auth on demand
app.get("/cb/test", async (req, res) => {
  try {
    const jwt = makeCBJWT("GET", "/api/v3/brokerage/accounts");
    if (!jwt) return res.json({ ok: false, error: "JWT generation failed — check server logs" });

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
    symbol: sym,
    price: sPrices[sym] || null,
    histLen: sHist[sym]?.length || 0
  }));
  const cryptoBoard = CRYPTO.map(sym => ({
    symbol: sym,
    price: cPrices[sym] || null,
    histLen: cHist[sym]?.length || 0
  }));
  res.json({
    stocks: stockBoard,
    crypto: cryptoBoard,
    raw: { ...sPrices, ...cPrices }
  });
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

// ─── BOT CONTROLS ─────────────────────────────────────────────────────────────
app.all("/bot/start", (req, res) => {
  if (!stockRunning) {
    stockRunning = true;
    stockTimer = setInterval(stockTick, 10000);
    stockTick();
    console.log("[BOT] Stock bot started");
  }
  if (!cryptoRunning) {
    cryptoRunning = true;
    cTimer = setInterval(cryptoTick, 15000);
    cryptoTick();
    console.log("[BOT] Crypto bot started");
  }
  res.json({ ok: true, stockRunning, cryptoRunning });
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
  if (!stockRunning) {
    stockRunning = true;
    stockTimer = setInterval(stockTick, 10000);
    stockTick();
  }
  res.json({ ok: true, stockRunning });
});

app.all("/bot/stop/stocks", (req, res) => {
  stockRunning = false;
  if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  res.json({ ok: true, stockRunning });
});

app.all("/bot/start/crypto", (req, res) => {
  if (!cryptoRunning) {
    cryptoRunning = true;
    cTimer = setInterval(cryptoTick, 15000);
    cryptoTick();
  }
  res.json({ ok: true, cryptoRunning });
});

app.all("/bot/stop/crypto", (req, res) => {
  cryptoRunning = false;
  if (cTimer) { clearInterval(cTimer); cTimer = null; }
  res.json({ ok: true, cryptoRunning });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ─── BOOT ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[APEX TRADE] Listening on port ${PORT} | PAPER=${PAPER} | MAX_PER_STOCK=$${MAX_PER_STOCK}`);

  // Test Coinbase auth before starting crypto bot
  await testCoinbaseAuth();

  stockRunning = true;
  stockTimer   = setInterval(stockTick, 10000);
  stockTick();

  cryptoRunning = true;
  cTimer = setInterval(cryptoTick, 15000);
  cryptoTick();

  // Keep Render alive
  setInterval(() => {
    fetch("https://apextrade-bot.onrender.com/ping").catch(() => {});
  }, 600000);

  // Watchdog: restart bots if they died (every hour)
  setInterval(() => {
    if (!stockRunning) {
      console.log("[WATCHDOG] Restarting stock bot");
      stockRunning = true;
      stockTimer   = setInterval(stockTick, 10000);
      stockTick();
    }
    if (!cryptoRunning) {
      console.log("[WATCHDOG] Restarting crypto bot");
      cryptoRunning = true;
      cTimer = setInterval(cryptoTick, 15000);
      cryptoTick();
    }
  }, 3600000);
});
