const express = require(“express”);
const path = require(“path”);
const app = express();

app.use(express.json());
app.use(express.static(__dirname));
app.use((req, res, next) => {
res.header(“Access-Control-Allow-Origin”, “*”);
res.header(“Access-Control-Allow-Methods”, “GET,POST,OPTIONS”);
res.header(“Access-Control-Allow-Headers”, “Content-Type”);
next();
});

const KEY    = process.env.ALPACA_KEY_ID;
const SECRET = process.env.ALPACA_SECRET_KEY;
const PAPER  = process.env.PAPER_TRADING !== “false”;
const BASE   = PAPER ? “https://paper-api.alpaca.markets” : “https://api.alpaca.markets”;
const DATA   = “https://data.alpaca.markets”;
const LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || “-200”);
const WATCHLIST  = [“SPY”,“NVDA”,“AAPL”,“MSFT”,“QQQ”];

let botRunning = false, dailyPnL = 0, trades = [], signals = [], prices = {}, priceHistory = {}, botInterval = null;

function alpacaGet(path) {
return fetch(BASE + path, { headers: { “APCA-API-KEY-ID”: KEY, “APCA-API-SECRET-KEY”: SECRET } }).then(r => r.json());
}
function alpacaPost(path, body) {
return fetch(BASE + path, { method: “POST”, headers: { “APCA-API-KEY-ID”: KEY, “APCA-API-SECRET-KEY”: SECRET, “Content-Type”: “application/json” }, body: JSON.stringify(body) }).then(r => r.json());
}
function dataGet(path) {
return fetch(DATA + path, { headers: { “APCA-API-KEY-ID”: KEY, “APCA-API-SECRET-KEY”: SECRET } }).then(r => r.json());
}

function getMomentumSignal(symbol) {
const h = priceHistory[symbol];
if (!h || h.length < 20) return null;
const ma20 = h.slice(-20).reduce((a, b) => a + b, 0) / 20;
const cur = h[h.length - 1];
const pct = ((cur - ma20) / ma20) * 100;
if (pct > 0.5)  return { type: “BUY”,  confidence: Math.min(99, Math.round(60 + pct * 8)),            reason: `${pct.toFixed(2)}% above MA20` };
if (pct < -0.5) return { type: “SELL”, confidence: Math.min(99, Math.round(60 + Math.abs(pct) * 8)), reason: `${Math.abs(pct).toFixed(2)}% below MA20` };
return null;
}

async function botTick() {
if (!botRunning) return;
if (dailyPnL <= LOSS_LIMIT) { botRunning = false; clearInterval(botInterval); console.log(“Loss limit hit”); return; }
try {
// Fetch prices
const syms = WATCHLIST.join(”,”);
const bars = await dataGet(`/v2/stocks/bars/latest?symbols=${syms}&feed=iex`);
if (bars.bars) {
for (const [sym, bar] of Object.entries(bars.bars)) {
prices[sym] = bar.c;
if (!priceHistory[sym]) priceHistory[sym] = [];
priceHistory[sym].push(bar.c);
if (priceHistory[sym].length > 50) priceHistory[sym].shift();
}
}
// Get positions
const posArr = await alpacaGet(”/v2/positions”);
const posMap = {};
if (Array.isArray(posArr)) posArr.forEach(p => posMap[p.symbol] = p);
// Check signals
signals = [];
for (const symbol of WATCHLIST) {
const price = prices[symbol];
if (!price) continue;
const signal = getMomentumSignal(symbol);
if (!signal) continue;
signals.push({ symbol, …signal, price, time: new Date().toLocaleTimeString() });
if (signal.confidence < 75) continue;
const hasPos = !!posMap[symbol];
if (signal.type === “BUY” && !hasPos) {
const acct = await alpacaGet(”/v2/account”);
const equity = parseFloat(acct.equity || 0);
const qty = Math.max(1, Math.floor((equity * 0.02) / (price * 0.02)));
const order = await alpacaPost(”/v2/orders”, { symbol, qty, side: “buy”, type: “market”, time_in_force: “day” });
if (order.id) { trades.unshift({ id: order.id, symbol, side: “BUY”, qty, price, pnl: null, time: new Date().toLocaleTimeString(), strategy: “Momentum MA20” }); if (trades.length > 50) trades.pop(); console.log(`BUY ${qty} ${symbol}`); }
}
if (signal.type === “SELL” && hasPos) {
const pos = posMap[symbol];
const qty = Math.abs(parseInt(pos.qty));
const order = await alpacaPost(”/v2/orders”, { symbol, qty, side: “sell”, type: “market”, time_in_force: “day” });
if (order.id) { const pnl = parseFloat(pos.unrealized_pl || 0); dailyPnL += pnl; trades.unshift({ id: order.id, symbol, side: “SELL”, qty, price, pnl, time: new Date().toLocaleTimeString(), strategy: “Momentum MA20” }); if (trades.length > 50) trades.pop(); console.log(`SELL ${qty} ${symbol} PnL: ${pnl}`); }
}
}
} catch(e) { console.error(“Bot tick error:”, e.message); }
}

app.get(”/status”, async (req, res) => {
try {
const acct = await alpacaGet(”/v2/account”);
const posArr = await alpacaGet(”/v2/positions”);
res.json({ botRunning, paper: PAPER, equity: parseFloat(acct.equity||0), cash: parseFloat(acct.cash||0), dailyPnL, dailyLossLimit: LOSS_LIMIT, positions: Array.isArray(posArr) ? posArr.map(p => ({ symbol: p.symbol, qty: p.qty, pnl: parseFloat(p.unrealized_pl||0), value: parseFloat(p.market_value||0) })) : [] });
} catch(e) { res.status(500).json({ error: e.message }); }
});

app.all(”/bot/start”, (req, res) => {
if (!botRunning) { botRunning = true; botInterval = setInterval(botTick, 60000); botTick(); console.log(“Bot started”); }
res.json({ ok: true, message: “Bot started”, botRunning });
});

app.all(”/bot/stop”, (req, res) => {
botRunning = false;
if (botInterval) { clearInterval(botInterval); botInterval = null; }
console.log(“Bot stopped”);
res.json({ ok: true, message: “Bot stopped”, botRunning });
});

app.get(”/trades”,  (req, res) => res.json({ trades }));
app.get(”/signals”, (req, res) => res.json({ signals }));
app.get(”/prices”,  (req, res) => res.json({ prices }));
app.get(”/ping”,    (req, res) => res.json({ ok: true }));
app.get(”/”,        (req, res) => res.sendFile(path.join(__dirname, “index.html”)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log(`APEX TRADE running on port ${PORT} | ${PAPER ? "PAPER" : "LIVE"}`);
setInterval(() => fetch(`https://apextrade-bot.onrender.com/ping`).catch(()=>{}), 14 * 60 * 1000);
});
