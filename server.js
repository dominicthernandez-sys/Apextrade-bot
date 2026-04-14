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
const WL = ["SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META","COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD","SOUN","IONQ","RGTI","QUBT","SMCI","ARM","AVGO","MU","CVNA","UBER","LYFT","DASH"];
const HDR = {"APCA-API-KEY-ID":KEY,"APCA-API-SECRET-KEY":SECRET};

// Database setup
const Database = require("better-sqlite3");
const db = new Database("./trades.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    symbol TEXT,
    side TEXT,
    qty INTEGER,
    price REAL,
    pnl REAL,
    time TEXT,
    date TEXT,
    strategy TEXT,
    created_at INTEGER
  );
`);

const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO trades (id, symbol, side, qty, price, pnl, time, date, strategy, created_at)
  VALUES (@id, @symbol, @side, @qty, @price, @pnl, @time, @date, @strategy, @created_at)
`);

function saveTrade(trade){
  try{
    var d=new Date();
    var date=d.toLocaleDateString("en-US",{timeZone:"America/New_York"});
    insertTrade.run({
      id: trade.id||("manual-"+Date.now()),
      symbol: trade.symbol,
      side: trade.side,
      qty: trade.qty||0,
      price: trade.price||0,
      pnl: trade.pnl||0,
      time: trade.time||"",
      date: date,
      strategy: trade.strategy||"",
      created_at: Date.now()
    });
  }catch(e){console.error("DB save error:",e.message);}
}

function getTradesDB(period){
  try{
    var d=new Date();
    if(period==="today"){
      var today=d.toLocaleDateString("en-US",{timeZone:"America/New_York"});
      return db.prepare("SELECT * FROM trades WHERE date=? ORDER BY created_at DESC LIMIT 100").all(today);
    } else if(period==="week"){
      var weekAgo=Date.now()-(7*24*60*60*1000);
      return db.prepare("SELECT * FROM trades WHERE created_at>? ORDER BY created_at DESC LIMIT 200").all(weekAgo);
    } else if(period==="month"){
      var monthAgo=Date.now()-(30*24*60*60*1000);
      return db.prepare("SELECT * FROM trades WHERE created_at>? ORDER BY created_at DESC LIMIT 500").all(monthAgo);
    } else {
      return db.prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT 500").all();
    }
  }catch(e){console.error("DB read error:",e.message);return [];}
}

function getPnLDB(period){
  try{
    var rows=getTradesDB(period);
    var total=rows.filter(function(r){return r.side==="SELL";}).reduce(function(a,r){return a+(r.pnl||0);},0);
    var wins=rows.filter(function(r){return r.side==="SELL"&&r.pnl>0;}).length;
    var losses=rows.filter(function(r){return r.side==="SELL"&&r.pnl<0;}).length;
    return{total:total,wins:wins,losses:losses,trades:rows.length};
  }catch(e){return{total:0,wins:0,losses:0,trades:0};}
}

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
            trades.unshift(t);if(trades.length>50)trades.pop();
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
          trades.unshift(bt);if(trades.length>50)trades.pop();
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
    var todayPnL=getPnLDB("today");
    res.json({botRunning:running,paper:PAPER,equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),dailyPnL:todayPnL.total,positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}) :[]});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/pnl",function(req,res){
  var today=getPnLDB("today");
  var week=getPnLDB("week");
  var month=getPnLDB("month");
  res.json({today:today,week:week,month:month});
});

app.post("/sell/all",async function(req,res){
  try{
    var posArr=await aget("/v2/positions");
    if(!Array.isArray(posArr)||posArr.length===0)return res.json({ok:true,message:"No positions to sell"});
    var results=[];
    for(var i=0;i<posArr.length;i++){
      var p=posArr[i];
      var qty=Math.abs(parseInt(p.qty));
      var ord=await apost("/v2/orders",{symbol:p.symbol,qty:qty,side:"sell",type:"market",time_in_force:"day"});
      if(ord.id){
        var sp=parseFloat(p.unrealized_pl||0);
        pnl+=sp;
        var t={id:ord.id,symbol:p.symbol,side:"SELL",qty:qty,price:parseFloat(p.current_price||0),pnl:sp,time:now(),strategy:"Manual sell all"};
        trades.unshift(t);if(trades.length>50)trades.pop();
        saveTrade(t);
        entryCount[p.symbol]=0;exitCount[p.symbol]=0;
        results.push(p.symbol);
      }
    }
    res.json({ok:true,sold:results});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post("/sell/:sym",async function(req,res){
  try{
    var sym=req.params.sym.toUpperCase();
    var posArr=await aget("/v2/positions");
    if(!Array.isArray(posArr))return res.json({ok:false,error:"No positions found"});
    var pos=posArr.find(function(p){return p.symbol===sym;});
    if(!pos)return res.json({ok:false,error:sym+" not found"});
    var qty=Math.abs(parseInt(pos.qty));
    var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"market",time_in_force:"day"});
    if(ord.id){
      var sp=parseFloat(pos.unrealized_pl||0);
      pnl+=sp;
      var t={id:ord.id,symbol:sym,side:"SELL",qty:qty,price:parseFloat(pos.current_price||0),pnl:sp,time:now(),strategy:"Manual sell"};
      trades.unshift(t);if(trades.length>50)trades.pop();
      saveTrade(t);
      entryCount[sym]=0;exitCount[sym]=0;
      res.json({ok:true,orderId:ord.id});
    } else {
      res.json({ok:false,error:JSON.stringify(ord)});
    }
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.all("/bot/start",function(req,res){startBot();res.json({ok:true,botRunning:true});});
app.all("/bot/stop",function(req,res){stopBot();res.json({ok:true,botRunning:false});});

app.get("/trades",function(req,res){
  var period=req.query.period||"today";
  var dbTrades=getTradesDB(period);
  res.json({trades:dbTrades});
});

app.get("/signals",function(req,res){res.json({signals:sigs});});
app.get("/prices",function(req,res){res.json({prices:prices});});
app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});

var PORT=process.env.PORT||3000;
app.listen(PORT,function(){
  console.log("APEX TRADE port "+PORT+" | "+(PAPER?"PAPER":"LIVE"));
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
