const Alpaca = require("@alpacahq/alpaca-trade-api");
const express = require("express");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const ALPACA_KEY = process.env.ALPACA_KEY_ID;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const PAPER = process.env.PAPER_TRADING !== "false";
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || "-200");

const alpaca = new Alpaca({
  keyId: ALPACA_KEY,
  secretKey: ALPACA_SECRET,
  paper: PAPER,
  feed: "iex",
});

let botRunning = false;
let dailyPnL = 0;
let trades = [];
let signals = [];
let lastPrices = {};
let priceHistory = {};
let botInterval = null;

const WATCHLIST = ["SPY", "NVDA", "AAPL", "MSFT", "QQQ"];

function safetyCheck() {
  if (dailyPnL <= DAILY_LOSS_LIMIT) {
    console.log("Daily loss limit hit. Stopping bot.");
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
  if (pctAbove > 0.5) return { type: "BUY", confidence: Math.min(99, Math.round(60 + pctAbove * 8)), reason: `Price ${pctAbove.toFixed(2)}% above MA20` };
  if (pctAbove < -0.5) return { type: "SELL", confidence: Math.min(99, Math.round(60 + Math.abs(pctAbove) * 8)), reason: `Price ${Math.abs(pctAbove).toFixed(2)}% below MA20` };
  return null;
}

async function calcQty(symbol, price) {
  try {
    const account = await alpaca.getAccount();
    const equity = parseFloat(account.equity);
    const maxRisk = equity * 0.02;
    const stopDist = price * 0.02;
    return Math.max(1, Math.floor(maxRisk / stopDist));
  } catch (e) {
    return 1;
  }
}

async function fetchPrices() {
  try {
    const bars = await alpaca.getBarsV2(WATCHLIST, { timeframe: "1Min", limit: 1 });
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
    console.error("Price fetch error:", e.message);
  }
}

async function getPositions() {
  try {
    const positions = await alpaca.getPositions();
    return positions.reduce((acc, p) => { acc[p.symbol] = p; return acc; }, {});
  } catch (e) {
    return {};
  }
}

async function placeOrder(symbol, side, qty) {
  try {
    const order = await alpaca.createOrder({
      symbol, qty,
      side: side.toLowerCase(),
      type: "market",
      time_in_force: "day",
    });
    console.log(`${side} ${qty}x ${symbol} | Order: ${order.id}`);
    return order;
  } catch (e) {
    console.error(`Order failed ${side} ${symbol}:`, e.message);
    return null;
  }
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
    signals.push({ symbol, ...signal, price, time: new Date().toLocaleTimeString() });
    if (signal.confidence < 75) continue;
    const hasPosition = !!positions[symbol];
    if (signal.type === "BUY" && !hasPosition) {
      const qty = await calcQty(symbol, price);
      const order = await placeOrder(symbol, "buy", qty);
      if (order) trades.unshift({ id: order.id, symbol, side: "BUY", qty, price, pnl: null, time: new Date().toLocaleTimeString(), strategy: "Momentum MA20" });
    }
    if (signal.type === "SELL" && hasPosition) {
      const pos = positions[symbol];
      const qty = Math.abs(parseInt(pos.qty));
      const order = await placeOrder(symbol, "sell", qty);
      if (order) {
        const pnl = parseFloat(pos.unrealized_pl || 0);
        dailyPnL += pnl;
        trades.unshift({ id: order.id, symbol, side: "SELL", qty, price, pnl, time: new Date().toLocaleTimeString(), strategy: "Momentum MA20" });
      }
    }
    if (trades.length > 50) trades = trades.slice(0, 50);
  }
}

app.get("/status", async (req, res) => {
  try {
    const account = await alpaca.getAccount();
    const positions = await alpaca.getPositions();
    res.json({
      botRunning, paper: PAPER,
      equity: parseFloat(account.equity),
      cash: parseFloat(account.cash),
      dailyPnL, dailyLossLimit: DAILY_LOSS_LIMIT,
      positions: positions.map(p => ({ symbol: p.symbol, qty: p.qty, pnl: parseFloat(p.unrealized_pl), value: parseFloat(p.market_value) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/bot/start", (req, res) => {
  if (botRunning) return res.json({ ok: true, message: "Already running" });
  botRunning = true;
  botInterval = setInterval(botTick, 60000);
  botTick();
  res.json({ ok: true, message: "Bot started" });
});

app.post("/bot/stop", (req, res) => {
  botRunning = false;
  if (botInterval) { clearInterval(botInterval); botInterval = null; }
  res.json({ ok: true, message: "Bot stopped" });
});

app.get("/trades", (req, res) => res.json({ trades }));
app.get("/signals", (req, res) => res.json({ signals }));
app.get("/prices", (req, res) => res.json({ prices: lastPrices }));
app.get("/", (req, res) => res.json({ status: "APEX TRADE bot online", paper: PAPER, botRunning }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`APEX TRADE server on port ${PORT} | ${PAPER ? "PAPER MODE" : "LIVE MODE"}`);

  // Keep alive — ping self every 14 minutes so Render never sleeps
  setInterval(async () => {
    try {
      await fetch(`https://apextrade-bot.onrender.com/`);
      console.log("Keep-alive ping sent");
    } catch (e) {
      console.log("Keep-alive ping failed:", e.message);
    }
  }, 14 * 60 * 1000);
});

  
