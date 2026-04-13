const express = require("express");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const KEY = process.env.ALPACA_KEY_ID;
const SECRET = process.env.ALPACA_SECRET_KEY;
const PAPER = process.env.PAPER_TRADING !== "false";
const BASE = PAPER ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
const DATA = "https://data.alpaca.markets";
const LOSS = parseFloat(process.env.DAILY_LOSS_LIMIT || "-200");
const DB_URL = process.env.DATABASE_URL;
const WL = ["SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META","COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD","SOUN","IONQ","RGTI","QUBT","SMCI","ARM","AVGO","MU","CVNA","UBER","LYFT","DASH"];
const HDR = {"APCA-API-KEY-ID":KEY,"APCA-API-SECRET-KEY":SECRET};

let running = true;
let pnl = 0;
let trades = [];
let sigs = [];
let prices = {};
let hist = {};
let volumes = {};
let timer = null;
let entryCount = {};
let exitCount = {};
let entryConf = {};
let lastTick = Date.now();
let tickCount = 0;
let db = null;

// Database setup
async function setupDB(){
  try{
    const{Client}=await import("pg");
    db=new Client({connectionString:DB_URL,ssl:{rejectUnauthorized:false}});
    await db.connect();
    await db.query(`CREATE TABLE IF NOT EXISTS trades(
      id SERIAL PRIMARY KEY,
      order_id TEXT,
      symbol TEXT,
      side TEXT,
      qty INTEGER,
      price NUMERIC,
      pnl NUMERIC,
      strategy TEXT,
      trade_time TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log("Database connected");
    // Load today's trades into memory
    var res=await db.query("SELECT * FROM trades WHERE created_at::date=CURRENT_DATE ORDER BY created_at DESC LIMIT 50");
    trades=res.rows.map(function(r){return{id:r.order_id,symbol:r.symbol,side:r.side,qty:r.qty,price:parseFloat(r.price||0),pnl:parseFloat(r.pnl||0),time:r.trade_time,strategy:r.strategy};});
    pnl=trades.filter(function(t){return t.side==="SELL";}).reduce(function(sum,t){return sum+(t.pnl||0);},0);
    console.log("Loaded "+trades.length+" trades from DB, pnl:$"+pnl.toFixed(2));
  }catch(e){
    console.error("DB setup error:",e.message);
  }
}

async function saveTrade(trade){
  if(!db)return;
  try{
    await db.query(
      "INSERT INTO trades(order_id,symbol,side,qty,price,pnl,strategy,trade_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [trade.id,trade.symbol,trade.side,trade.qty,trade.price||0,trade.pnl||0,trade.strategy,trade.time]
    );
  }catch(e){console.error("Save trade error:",e.message);}
}

async function getTradeHistory(period){
  if(!db)return[];
  try{
    var q="SELECT * FROM trades WHERE 1=1";
    if(period==="today")q+=" AND created_at::date=CURRENT_DATE";
    else if(period==="week")q+=" AND created_at>=NOW()-INTERVAL '7 days'";
    else if(period==="month")q+=" AND created_at>=NOW()-INTERVAL '30 days'";
    q+=" ORDER BY created_at DESC LIMIT 100";
    var res=await db.query(q);
    return res.rows.map(function(r){return{id:r.order_id,symbol:r.symbol,side:r.side,qty:r.qty,price:parseFloat(r.price||0),pnl:parseFloat(r.pnl||0),time:r.trade_time,strategy:r.strategy};});
  }catch(e){console.error("History error:",e.message);return[];}
}

function aget(u){return fetch(BASE+u,{headers:HDR}).then(function(r){return r.json();});}
function apost(u,b){return fetch(BASE+u,{method:"POST",headers:Object.assign({"Content-Type":"application/json"},HDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}
function dget(u){return fetch(DATA+u,{headers:HDR}).then(function(r){return r.json();});}
function now(){return new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit"});}

function calcRSI(arr){
  if(arr.length<14)return 50;
  var gains=0,losses=0;
  for(var i=arr.length-14;i<arr.length;i++){
    var diff=arr[i]-(arr[i-1]||arr[i]);
    if(diff>0)gains+=diff;
    else losses+=Math.abs(diff);
  }
  return 100-(100/(1+(gains/(losses||1))));
}

function avgVol(arr){
  if(!arr||arr.length<2)return 0;
  return arr.reduce(function(a,b){return a+b;},0)/arr.length;
}

function getSig(sym){
  var h=hist[sym];
  if(!h||h.length<15)return null;
  var cur=h[h.length-1];
  var ma10=h.slice(-10).reduce(function(a,b){return a+b;},0)/10;
  var ma50=h.slice(-Math.min(50,h.length)).reduce(function(a,b){return a+b;},0)/Math.min(50,h.length);
  var rsi=calcRSI(h);
  var vols=volumes[sym]||[];
  var av=avgVol(vols.slice(0,-1));
  var cv=vols[vols.length-1]||0;
  var volOk=av===0||cv>=av;
  var pct=((cur-ma10)/ma10)*100;
  if(pct>0.2&&cur>ma50&&rsi<70&&volOk){
    var conf=Math.min(99,Math.round(60+pct*8));
    if(rsi<50)conf=Math.min(99,conf+5);
    if(cv>av*1.5)conf=Math.min(99,conf+5);
    return{type:"BUY",confidence:conf,reason:pct.toFixed(2)+"% above MA10 | RSI:"+Math.round(rsi),rsi:rsi};
  }
  if(pct<-0.2&&cur<ma50&&rsi>30&&volOk){
    var conf2=Math.min(99,Math.round(60+Math.abs(pct)*8));
    return{type:"SELL",confidence:conf2,reason:Math.abs(pct).toFixed(2)+"% below MA10 | RSI:"+Math.round(rsi),rsi:rsi};
  }
  return null;
}

async function tick(){
  if(!running)return;
  if(pnl<=LOSS){running=false;clearInterval(timer);console.log("Loss limit hit");return;}
  lastTick=Date.now();
  tickCount++;
  try{
    var snap=await dget("/v2/stocks/snapshots?symbols="+WL.join(",")+"&feed=iex");
    if(snap){
      Object.keys(snap).forEach(function(s){
        var d=snap[s];
        var p=d&&d.latestTrade&&d.latestTrade.p||d&&d.minuteBar&&d.minuteBar.c||d&&d.dailyBar&&d.dailyBar.c;
        var v=d&&d.minuteBar&&d.minuteBar.v||0;
        if(p){
          prices[s]=p;
          if(!hist[s])hist[s]=[];
          if(!hist[s].length||hist[s][hist[s].length-1]!==p){hist[s].push(p);if(hist[s].length>100)hist[s].shift();}
          if(!volumes[s])volumes[s]=[];
          if(v>0){volumes[s].push(v);if(volumes[s].length>50)volumes[s].shift();}
        }
      });
    }
    var posArr=await aget("/v2/positions");
    var posMap={};
    if(Array.isArray(posArr))posArr.forEach(function(p){posMap[p.symbol]=p;});
    Object.keys(entryCount).forEach(function(sym){if(!posMap[sym]){entryCount[sym]=0;exitCount[sym]=0;entryConf[sym]=0;}});
    sigs=[];
    for(var i=0;i<WL.length;i++){
      var sym=WL[i];
      var price=prices[sym];
      if(!price)continue;
      var sig=getSig(sym);
      if(!sig)continue;
      sigs.push({symbol:sym,type:sig.type,confidence:sig.confidence,reason:sig.reason,rsi:Math.round(sig.rsi),price:price,time:now()});
      if(posMap[sym]){
        var pos=posMap[sym];
        var sq=Math.abs(parseInt(pos.qty));
        var ep=parseFloat(pos.avg_entry_price||price);
        var gp=((price-ep)/ep)*100;
        var unrealized=parseFloat(pos.unrealized_pl||0);
        var dh=Math.floor((Date.now()-new Date(pos.created_at||Date.now()).getTime())/86400000);
        if(!exitCount[sym])exitCount[sym]=0;
        var conf=entryConf[sym]||65;
        var third=Math.max(1,Math.floor(sq/3));
        var sell=false,sellQty=sq,why="";
        if(unrealized>=100&&conf<75&&exitCount[sym]<1){sell=true;sellQty=sq;why="$100 quick win";entryCount[sym]=0;exitCount[sym]=0;}
        else if(unrealized>=150&&conf<85&&exitCount[sym]<1){sell=true;sellQty=sq;why="$150 quick win";entryCount[sym]=0;exitCount[sym]=0;}
        else if(unrealized>=200&&conf<90&&exitCount[sym]<1){sell=true;sellQty=sq;why="$200 quick win";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp<=-15){sell=true;sellQty=sq;why="15pct stoploss";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp>=35&&exitCount[sym]<3){sell=true;sellQty=sq;why="35pct final exit";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp>=20&&exitCount[sym]<2){sell=true;sellQty=third;why="20pct scale out 2/3";exitCount[sym]=2;}
        else if(gp>=10&&exitCount[sym]<1){sell=true;sellQty=third;why="10pct scale out 1/3";exitCount[sym]=1;}
        else if(dh>=5&&gp<5){sell=true;sellQty=sq;why="5day limit";entryCount[sym]=0;exitCount[sym]=0;}
        else if(sig.type==="SELL"&&gp<0){sell=true;sellQty=sq;why="momentum sell";entryCount[sym]=0;exitCount[sym]=0;}
        if(sell&&sellQty>0){
          var so=await apost("/v2/orders",{symbol:sym,qty:sellQty,side:"sell",type:"market",time_in_force:"day"});
          if(so.id){
            var sp=unrealized*(sellQty/sq);
            pnl+=sp;
            var t={id:so.id,symbol:sym,side:"SELL",qty:sellQty,price:price,pnl:sp,time:now(),strategy:why};
            trades.unshift(t);
            if(trades.length>50)trades.pop();
            saveTrade(t);
            console.log("SELL "+sym+" "+why+" pnl:$"+sp.toFixed(2));
          }
        }
        continue;
      }
      if(sig.type==="BUY"&&sig.confidence>=65){
        if(posMap[sym])continue;
        if(!entryCount[sym])entryCount[sym]=0;
        var maxEntry=sig.confidence>=85?3:sig.confidence>=75?2:1;
        if(entryCount[sym]>=maxEntry)continue;
        var acct=await aget("/v2/account");
        var eq=parseFloat(acct.equity||0);
        var tot=Object.keys(posMap).reduce(function(sum,k){return sum+parseFloat(posMap[k].market_value||0);},0);
        var maxExp=eq*(sig.confidence>=90?0.35:0.20);
        if(tot>=maxExp)continue;
        var rem=maxExp-tot;
        var qty=Math.max(1,Math.floor((rem/3)/price));
        if(qty<1)continue;
        var stopPrice=parseFloat((price*0.85).toFixed(2));
        var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"buy",type:"market",time_in_force:"day"});
        if(ord.id){
          await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"stop",stop_price:stopPrice,time_in_force:"gtc"});
          entryCount[sym]++;
          entryConf[sym]=sig.confidence;
          var label="Entry "+entryCount[sym]+"/3";
          var bt={id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:now(),strategy:label};
          trades.unshift(bt);
          if(trades.length>50)trades.pop();
          saveTrade(bt);
          console.log("BUY "+sym+" "+label+" RSI:"+Math.round(sig.rsi)+" conf:"+sig.confidence+"%");
        }
      }
    }
  }catch(e){console.error("Tick error:",e.message);}
}

function startBot(){
  running=true;
  if(timer){clearInterval(timer);}
  timer=setInterval(tick,10000);
  tick();
  console.log("Bot started");
}

function stopBot(){
  running=false;
  if(timer){clearInterval(timer);timer=null;}
  console.log("Bot stopped");
}

app.get("/ping",function(req,res){
  if(running&&!timer){startBot();}
  res.json({ok:true,running:running,lastTick:lastTick,tickCount:tickCount});
});

app.get("/status",async function(req,res){
  try{
    var a=await aget("/v2/account");
    var p=await aget("/v2/positions");
    res.json({botRunning:running,paper:PAPER,equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),dailyPnL:pnl,positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}) :[]});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/trades",async function(req,res){
  var period=req.query.period||"today";
  if(db){
    var hist=await getTradeHistory(period);
    res.json({trades:hist});
  } else {
    res.json({trades:trades});
  }
});

app.get("/signals",function(req,res){res.json({signals:sigs});});
app.get("/prices",function(req,res){res.json({prices:prices});});
app.all("/bot/start",function(req,res){startBot();res.json({ok:true,botRunning:true});});
app.all("/bot/stop",function(req,res){stopBot();res.json({ok:true,botRunning:false});});
app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});

var PORT=process.env.PORT||3000;
app.listen(PORT,async function(){
  console.log("APEX TRADE port "+PORT+" | "+(PAPER?"PAPER":"LIVE"));
  await setupDB();
  startBot();
  setInterval(function(){
    fetch("https://apextrade-bot.onrender.com/ping")
      .then(function(r){return r.json();})
      .then(function(d){if(!d.running){startBot();}})
      .catch(function(e){console.log("Ping failed:"+e.message);});
  },30000);
  setInterval(function(){
    var secs=(Date.now()-lastTick)/1000;
    if(running&&secs>60){console.log("Watchdog restart");startBot();}
  },120000);
});
