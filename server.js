const Alpaca = require(”@alpacahq/alpaca-trade-api”);
const express = require(“express”);
const path = require(“path”);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.use((req, res, next) => {
res.header(“Access-Control-Allow-Origin”, “*”);
res.header(“Access-Control-Allow-Headers”, “Content-Type”);
res.header(“Access-Control-Allow-Methods”, “GET,POST,OPTIONS”);
next();
});

const ALPACA_KEY    = process.env.ALPACA_KEY_ID;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const PAPER         = process.env.PAPER_TRADING !== “false”;
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || “-200”);

const alpaca = new Alpaca({ keyId: ALPACA_KEY, secretKey: ALPACA_SECRET, paper: PAPER, feed: “iex” });

let botRunning = false, dailyPnL = 0, trades = [], signals = [], lastPrices = {}, priceHistory = {}, botInterval = null;
const WATCHLIST = [“SPY”, “NVDA”, “AAPL”, “MSFT”, “QQQ”];

function safetyCheck() {
if (dailyPnL <= DAILY_LOSS_LIMIT) {
botRunning = false;
clearInterval(botInterval);
botInterval = null;
return false;
}
return true;
}

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

async function calcQty(symbol, price) {
try {
const a = await alpaca.getAccount();
return Math.max(1, Math.floor((parseFloat(a.equity) * 0.02) / (price * 0.02)));
} catch { return 1; }
}

async function fetchPrices() {
try {
const bars = await alpaca.getBarsV2(WATCHLIST, { timeframe: “1Min”, limit: 1 });
for await (const bar of bars) {
const sym = bar.Symbol || bar.S, price = bar.ClosePrice || bar.c;
if (!sym || !price) continue;
lastPrices[sym] = price;
if (!priceHistory[sym]) priceHistory[sym] = [];
priceHistory[sym].push(price);
if (priceHistory[sym].length > 50) priceHistory[sym].shift();
}
} catch(e) { console.error(“Price fetch error:”, e.message); }
}

async function getPositions() {
try {
const p = await alpaca.getPositions();
return p.reduce((acc, p) => { acc[p.symbol] = p; return acc; }, {});
} catch { return {}; }
}

async function placeOrder(symbol, side, qty) {
try {
return await alpaca.createOrder({ symbol, qty, side: side.toLowerCase(), type: “market”, time_in_force: “day” });
} catch(e) { console.error(“Order failed:”, e.message); return null; }
}

async function botTick() {
if (!botRunning || !safetyCheck()) return;
await fetchPrices();
const positions = await getPositions();
signals = [];
for (const symbol of WATCHLIST) {
const price = lastPrices[symbol];
if (!price) continue;
const signal = getMomentumSignal(symbol);
if (!signal) continue;
signals.push({ symbol, …signal, price, time: new Date().toLocaleTimeString() });
if (signal.confidence < 75) continue;
const hasPosition = !!positions[symbol];
if (signal.type === “BUY” && !hasPosition) {
const qty = await calcQty(symbol, price);
const order = await placeOrder(symbol, “buy”, qty);
if (order) { trades.unshift({ id: order.id, symbol, side: “BUY”, qty, price, pnl: null, time: new Date().toLocaleTimeString(), strategy: “Momentum MA20” }); if (trades.length > 50) trades.pop(); }
}
if (signal.type === “SELL” && hasPosition) {
const pos = positions[symbol], qty = Math.abs(parseInt(pos.qty));
const order = await placeOrder(symbol, “sell”, qty);
if (order) { const pnl = parseFloat(pos.unrealized_pl || 0); dailyPnL += pnl; trades.unshift({ id: order.id, symbol, side: “SELL”, qty, price, pnl, time: new Date().toLocaleTimeString(), strategy: “Momentum MA20” }); if (trades.length > 50) trades.pop(); }
}
}
}

// Routes
app.get(”/status”, async (req, res) => {
try {
const account = await alpaca.getAccount();
const positions = await alpaca.getPositions();
res.json({
botRunning, paper: PAPER,
equity: parseFloat(account.equity),
cash: parseFloat(account.cash),
dailyPnL, dailyLossLimit: DAILY_LOSS_LIMIT,
positions: positions.map(p => ({ symbol: p.symbol, qty: p.qty, pnl: parseFloat(p.unrealized_pl), value: parseFloat(p.market_value) }))
});
} catch(e) { res.status(500).json({ error: e.message }); }
});

app.all(”/bot/start”, (req, res) => {
if (!botRunning) { botRunning = true; botInterval = setInterval(botTick, 60000); botTick(); }
res.json({ ok: true, message: “Bot started”, botRunning });
});

app.all(”/bot/stop”, (req, res) => {
botRunning = false;
if (botInterval) { clearInterval(botInterval); botInterval = null; }
res.json({ ok: true, message: “Bot stopped”, botRunning });
});

app.get(”/trades”,  (req, res) => res.json({ trades }));
app.get(”/signals”, (req, res) => res.json({ signals }));
app.get(”/prices”,  (req, res) => res.json({ prices: lastPrices }));
app.get(”/ping”,    (req, res) => res.json({ ok: true }));

app.get(”/”, (req, res) => res.sendFile(path.join(__dirname, “index.html”)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log(`APEX TRADE on port ${PORT} | ${PAPER ? "PAPER" : "LIVE"}`);
setInterval(async () => {
try { await fetch(“https://apextrade-bot.onrender.com/ping”); console.log(“Keep-alive ping”); } catch(e) {}
}, 14 * 60 * 1000);
});
