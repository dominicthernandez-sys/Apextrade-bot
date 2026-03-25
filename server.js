const Alpaca = require(”@alpacahq/alpaca-trade-api”);
const express = require(“express”);

const app = express();
app.use(express.json());
app.use((req, res, next) => {
res.header(“Access-Control-Allow-Origin”, “*”);
res.header(“Access-Control-Allow-Headers”, “Content-Type”);
next();
});

// ── Config ────────────────────────────────────────────────────────────────────
const ALPACA_KEY    = process.env.ALPACA_KEY_ID;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const PAPER         = process.env.PAPER_TRADING !== “false”; // default: paper
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || “-200”);
const RISK_PER_TRADE   = parseFloat(process.env.RISK_PER_TRADE   || “0.02”); // 2%

const alpaca = new Alpaca({
keyId:     ALPACA_KEY,
secretKey: ALPACA_SECRET,
paper:     PAPER,
feed:      “iex”,
});

// ── State ─────────────────────────────────────────────────────────────────────
let botRunning   = false;
let dailyPnL     = 0;
let trades       = [];
let signals      = [];
let lastPrices   = {};
let priceHistory = {}; // symbol -> [prices]
let botInterval  = null;

// Watchlist — symbols the bot monitors
const WATCHLIST = [“SPY”, “NVDA”, “AAPL”, “MSFT”, “QQQ”];

// ── Safety check ──────────────────────────────────────────────────────────────
function safetyCheck() {
if (dailyPnL <= DAILY_LOSS_LIMIT) {
console.log(`🛑 Daily loss limit hit ($${dailyPnL}). Stopping bot.`);
botRunning = false;
clearInterval(botInterval);
botInterval = null;
return false;
}
return true;
}

// ── Momentum signal: price above 20-period MA = bullish ───────────────────────
function getMomentumSignal(symbol) {
const history = priceHistory[symbol];
if (!history || history.length < 20) return null;
const ma20 = history.slice(-20).reduce((a, b) => a + b, 0) / 20;
const current = history[history.length - 1];
const pctAbove = ((current - ma20) / ma20) * 100;
if (pctAbove > 0.5)  return { type: “BUY”,  confidence: Math.min(99, Math.round(60 + pctAbove * 8)), reason: `Price ${pctAbove.toFixed(2)}% above MA20` };
if (pctAbove < -0.5) return { type: “SELL”, confidence: Math.min(99, Math.round(60 + Math.abs(pctAbove) * 8)), reason: `Price ${Math.abs(pctAbove).toFixed(2)}% below MA20` };
return null;
}

// ── Position sizing (2% rule) ─────────────────────────────────────────────────
async function calcQty(symbol, price) {
try {
const account = await alpaca.getAccount();
const equity  = parseFloat(account.equity);
const maxRisk = equity * RISK_PER_TRADE;
const stopDist = price * 0.02; // 2% stop distance
const qty = Math.floor(maxRisk / stopDist);
return Math.max(1, qty);
} catch (e) {
return 1;
}
}

// ── Fetch latest prices ───────────────────────────────────────────────────────
async function fetchPrices() {
try {
const bars = await alpaca.getBarsV2(WATCHLIST, {
timeframe: “1Min”,
limit: 1,
});
for await (const bar of bars) {
const sym = bar.Symbol || bar.S;
const price = bar.ClosePrice || bar.c;
if (!sym || !price) continue;
lastPrices[sym] = price;
if (!priceHistory[sym]) priceHistory[sym] = [];
priceHistory[sym].push(price);
if (priceHistory[sym].length > 50) priceHistory[sym].shift();
}
} catch (e) {
console.error(“Price fetch error:”, e.message);
}
}

// ── Check existing positions ──────────────────────────────────────────────────
async function getPositions() {
try {
const positions = await alpaca.getPositions();
return positions.reduce((acc, p) => {
acc[p.symbol] = p;
return acc;
}, {});
} catch (e) {
return {};
}
}

// ── Place order ───────────────────────────────────────────────────────────────
async function placeOrder(symbol, side, qty) {
try {
const order = await alpaca.createOrder({
symbol,
qty,
side:           side.toLowerCase(),
type:           “market”,
time_in_force:  “day”,
});
console.log(`✅ ${side} ${qty}x ${symbol} | Order: ${order.id}`);
return order;
} catch (e) {
console.error(`❌ Order failed ${side} ${symbol}:`, e.message);
return null;
}
}

// ── Main bot tick ─────────────────────────────────────────────────────────────
async function botTick() {
if (!botRunning || !safetyCheck()) return;

await fetchPrices();
const positions = await getPositions();
signals = [];

for (const symbol of WATCHLIST) {
const price  = lastPrices[symbol];
if (!price) continue;

```
const signal = getMomentumSignal(symbol);
if (!signal) continue;

signals.push({ symbol, ...signal, price, time: new Date().toLocaleTimeString() });

if (signal.confidence < 75) continue; // Only act on high-confidence signals

const hasPosition = !!positions[symbol];

if (signal.type === "BUY" && !hasPosition) {
  const qty   = await calcQty(symbol, price);
  const order = await placeOrder(symbol, "buy", qty);
  if (order) {
    const trade = { id: order.id, symbol, side: "BUY", qty, price, pnl: null, time: new Date().toLocaleTimeString(), strategy: "Momentum MA20" };
    trades.unshift(trade);
    if (trades.length > 50) trades.pop();
  }
}

if (signal.type === "SELL" && hasPosition) {
  const pos = positions[symbol];
  const qty = Math.abs(parseInt(pos.qty));
  const order = await placeOrder(symbol, "sell", qty);
  if (order) {
    const pnl   = parseFloat(pos.unrealized_pl || 0);
    dailyPnL   += pnl;
    const trade = { id: order.id, symbol, side: "SELL", qty, price, pnl, time: new Date().toLocaleTimeString(), strategy: "Momentum MA20" };
    trades.unshift(trade);
    if (trades.length > 50) trades.pop();
  }
}
```

}
}

// ── API routes (your dashboard calls these) ───────────────────────────────────

// Dashboard status
app.get(”/status”, async (req, res) => {
try {
const account   = await alpaca.getAccount();
const positions = await alpaca.getPositions();
res.json({
botRunning,
paper: PAPER,
equity:       parseFloat(account.equity),
cash:         parseFloat(account.cash),
dailyPnL,
dailyLossLimit: DAILY_LOSS_LIMIT,
positions:    positions.map(p => ({
symbol: p.symbol,
qty:    p.qty,
pnl:    parseFloat(p.unrealized_pl),
value:  parseFloat(p.market_value),
})),
});
} catch (e) {
res.status(500).json({ error: e.message });
}
});

// Start bot
app.post(”/bot/start”, (req, res) => {
if (botRunning) return res.json({ ok: true, message: “Already running” });
botRunning  = true;
botInterval = setInterval(botTick, 60000); // every 1 minute
botTick();  // run immediately
console.log(“▶ Bot started”);
res.json({ ok: true, message: “Bot started” });
});

// Stop bot
app.post(”/bot/stop”, (req, res) => {
botRunning = false;
if (botInterval) { clearInterval(botInterval); botInterval = null; }
console.log(“⏸ Bot stopped”);
res.json({ ok: true, message: “Bot stopped” });
});

// Recent trades
app.get(”/trades”, (req, res) => res.json({ trades }));

// Latest signals
app.get(”/signals”, (req, res) => res.json({ signals }));

// Live prices
app.get(”/prices”, (req, res) => res.json({ prices: lastPrices }));

// Health check
app.get(”/”, (req, res) => res.json({ status: “APEX TRADE bot running”, paper: PAPER, botRunning }));

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log(`🚀 APEX TRADE server on port ${PORT}`);
console.log(`   Mode: ${PAPER ? "PAPER TRADING" : "⚠️  LIVE TRADING"}`);
console.log(`   Daily loss limit: $${DAILY_LOSS_LIMIT}`);
});
