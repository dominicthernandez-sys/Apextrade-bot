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

const KEY = process.env.ALPACA_KEY_ID;
const SECRET = process.env.ALPACA_SECRET_KEY;
const PAPER = process.env.PAPER_TRADING !== “false”;
const BASE = PAPER ? “https://paper-api.alpaca.markets” : “https://api.alpaca.markets”;
const DATA = “https://data.alpaca.markets”;
const LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || “-200”);
const WATCHLIST = [“SPY”,“NVDA”,“AAPL”,“MSFT”,“QQQ”];

let botRunning = false;
let dailyPnL = 0;
let trades = [];
let signals = [];
let prices = {};
let priceHistory = {};
let botInterval = null;

function alpacaGet(url) {
return fetch(BASE + url, {
headers: { “APCA-API-KEY-ID”: KEY, “APCA-API-SECRET-KEY”: SECRET }
}).then(function(r) { return r.json(); });
}

function alpacaPost(url, body) {
return fetch(BASE + url, {
method: “POST”,
headers: {
“APCA-API-KEY-ID”: KEY,
“APCA-API-SECRET-KEY”: SECRET,
“Content-Type”: “application/json”
},
body: JSON.stringify(body)
}).then(function(r) { return r.json(); });
}

function dataGet(url) {
return fetch(DATA + url, {
headers: { “APCA-API-KEY-ID”: KEY, “APCA-API-SECRET-KEY”: SECRET }
}).then(function(r) { return r.json(); });
}

function getSignal(symbol) {
var h = priceHistory[symbol];
if (!h || h.length < 20) return null;
var ma20 = h.slice(-20).reduce(function(a, b) { return a + b; }, 0) / 20;
var cur = h[h.length - 1];
var pct = ((cur - ma20) / ma20) * 100;
if (pct > 0.5) return { type: “BUY”, confidence: Math.min(99, Math.round(60 + pct * 8)), reason: pct.toFixed(2) + “% above MA20” };
if (pct < -0.5) return { type: “SELL”, confidence: Math.min(99, Math.round(60 + Math.abs(pct) * 8)), reason: Math.abs(pct).toFixed(2) + “% below MA20” };
return null;
}

async function botTick() {
if (!botRunning) return;
if (dailyPnL <= LOSS_LIMIT) {
botRunning = false;
clearInterval(botInterval);
console.log(“Loss limit hit, stopping bot”);
return;
}
try {
var syms = WATCHLIST.join(”,”);
var bars = await dataGet(”/v2/stocks/bars/latest?symbols=” + syms + “&feed=iex”);
if (bars.bars) {
var keys = Object.keys(bars.bars);
for (var i = 0; i < keys.length; i++) {
var sym = keys[i];
var bar = bars.bars[sym];
prices[sym] = bar.c;
if (!priceHistory[sym]) priceHistory[sym] = [];
priceHistory[sym].push(bar.c);
if (priceHistory[sym].length > 50) priceHistory[sym].shift();
}
}
var posArr = await alpacaGet(”/v2/positions”);
var posMap = {};
if (Array.isArray(posArr)) {
posArr.forEach(function(p) { posMap[p.symbol] = p; });
}
signals = [];
for (var j = 0; j < WATCHLIST.length; j++) {
var symbol = WATCHLIST[j];
var price = prices[symbol];
if (!price) continue;
var signal = getSignal(symbol);
if (!signal) continue;
signals.push({ symbol: symbol, type: signal.type, confidence: signal.confidence, reason: signal.reason, price: price, time: new Date().toLocaleTimeString() });
if (signal.confidence < 75) continue;
var hasPos = !!posMap[symbol];
if (signal.type === “BUY” && !hasPos) {
var acct = await alpacaGet(”/v2/account”);
var equity = parseFloat(acct.equity || 0);
var qty = Math.max(1, Math.floor((equity * 0.02) / (price * 0.02)));
var order = await alpacaPost(”/v2/orders”, { symbol: symbol, qty: qty, side: “buy”, type: “market”, time_in_force: “day” });
if (order.id) {
trades.unshift({ id: order.id, symbol: symbol, side: “BUY”, qty: qty, price: price, pnl: null, time: new Date().toLocaleTimeString(), strategy: “Momentum MA20” });
if (trades.length > 50) trades.pop();
console.log(“BUY “ + qty + “ “ + symbol);
}
}
if (signal.type === “SELL” && hasPos) {
var pos = posMap[symbol];
var sellQty = Math.abs(parseInt(pos.qty));
var sellOrder = await alpacaPost(”/v2/orders”, { symbol: symbol, qty: sellQty, side: “sell”, type: “market”, time_in_force: “day” });
if (sellOrder.id) {
var pnl = parseFloat(pos.unrealized_pl || 0);
dailyPnL += pnl;
trades.unshift({ id: sellOrder.id, symbol: symbol, side: “SELL”, qty: sellQty, price: price, pnl: pnl, time: new Date().toLocaleTimeString(), strategy: “Momentum MA20” });
if (trades.length > 50) trades.pop();
console.log(“SELL “ + sellQty + “ “ + symbol + “ PnL: “ + pnl);
}
}
}
} catch(e) {
console.error(“Bot tick error: “ + e.message);
}
}

app.get(”/status”, async function(req, res) {
try {
var acct = await alpacaGet(”/v2/account”);
var posArr = await alpacaGet(”/v2/positions”);
var posList = Array.isArray(posArr) ? posArr.map(function(p) {
return { symbol: p.symbol, qty: p.qty, pnl: parseFloat(p.unrealized_pl || 0), value: parseFloat(p.market_value || 0) };
}) : [];
res.json({ botRunning: botRunning, paper: PAPER, equity: parseFloat(acct.equity || 0), cash: parseFloat(acct.cash || 0), dailyPnL: dailyPnL, dailyLossLimit: LOSS_LIMIT, positions: posList });
} catch(e) {
res.status(500).json({ error: e.message });
}
});

app.all(”/bot/start”, function(req, res) {
if (!botRunning) {
botRunning = true;
botInterval = setInterval(botTick, 60000);
botTick();
console.log(“Bot started”);
}
res.json({ ok: true, message: “Bot started”, botRunning: botRunning });
});

app.all(”/bot/stop”, function(req, res) {
botRunning = false;
if (botInterval) { clearInterval(botInterval); botInterval = null; }
console.log(“Bot stopped”);
res.json({ ok: true, message: “Bot stopped”, botRunning: botRunning });
});

app.get(”/trades”, function(req, res) { res.json({ trades: trades }); });
app.get(”/signals”, function(req, res) { res.json({ signals: signals }); });
app.get(”/prices”, function(req, res) { res.json({ prices: prices }); });
app.get(”/ping”, function(req, res) { res.json({ ok: true }); });
app.get(”/”, function(req, res) { res.sendFile(path.join(__dirname, “index.html”)); });

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
console.log(“APEX TRADE running on port “ + PORT + “ | “ + (PAPER ? “PAPER” : “LIVE”));
setInterval(function() {
fetch(“https://apextrade-bot.onrender.com/ping”).catch(function() {});
}, 14 * 60 * 1000);
});
