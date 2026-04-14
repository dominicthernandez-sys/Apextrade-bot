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
const LOSS = parseFloat(process.env.DAILY_LOSS_LIMIT || "-500");
const DB_URL = process.env.DATABASE_URL;
const HDR = {"APCA-API-KEY-ID":KEY,"APCA-API-SECRET-KEY":SECRET};

const MEAN_REV = ["MSTR","MARA","COIN","HOOD","SOUN","IONQ","RGTI","QUBT","RIVN","SOFI"];
const BREAKOUT = ["SPY","QQQ","AAPL","MSFT","GOOGL","AMZN","META","NVDA","TSLA","AMD"];
const VWAP_GRP = ["PLTR","AVGO","MU","SMCI","ARM","CVNA","UBER","LYFT","DASH"];
const WL = [...new Set([...MEAN_REV,...BREAKOUT,...VWAP_GRP])];

let running=true,pnl=0,trades=[],sigs=[],prices={},hist={},volumes={};
let timer=null,entryCount={},exitCount={},entryConf={},buyLock={};
let lastTick=Date.now(),tickCount=0;
let dayOpen={},vwapPrice={},vwapVol={},orHigh={},orLow={},orSet={};
let db=null;

function aget(u){return fetch(BASE+u,{headers:HDR}).then(function(r){return r.json();});}
function apost(u,b){return fetch(BASE+u,{method:"POST",headers:Object.assign({"Content-Type":"application/json"},HDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}
function dget(u){return fetch(DATA+u,{headers:HDR}).then(function(r){return r.json();});}
function now(){return new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function minsAfterOpen(){
  var et=new Date().toLocaleString("en-US",{timeZone:"America/New_York"});
  var d=new Date(et);
  return(d.getHours()-9)*60+(d.getMinutes()-30);
}

async function setupDB(){
  if(!DB_URL)return;
  try{
    const{Client}=await import("pg");
    db=new Client({connectionString:DB_URL,ssl:{rejectUnauthorized:false}});
    await db.connect();
    await db.query(`CREATE TABLE IF NOT EXISTS trades(
      id SERIAL PRIMARY KEY,order_id TEXT,symbol TEXT,side TEXT,
      qty INTEGER,price NUMERIC,pnl NUMERIC,strategy TEXT,
      trade_time TEXT,created_at TIMESTAMP DEFAULT NOW()
    )`);
    var res=await db.query("SELECT * FROM trades WHERE created_at::date=CURRENT_DATE ORDER BY created_at DESC LIMIT 50");
    trades=res.rows.map(function(r){return{id:r.order_id,symbol:r.symbol,side:r.side,qty:r.qty,price:parseFloat(r.price||0),pnl:parseFloat(r.pnl||0),time:r.trade_time,strategy:r.strategy};});
    pnl=trades.filter(function(t){return t.side==="SELL";}).reduce(function(s,t){return s+(t.pnl||0);},0);
    console.log("DB ready, "+trades.length+" trades, pnl:$"+pnl.toFixed(2));
  }catch(e){console.error("DB error:",e.message);}
}

async function saveTrade(t){
  if(!db)return;
  try{await db.query("INSERT INTO trades(order_id,symbol,side,qty,price,pnl,strategy,trade_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[t.id,t.symbol,t.side,t.qty,t.price||0,t.pnl||0,t.strategy,t.time]);}
  catch(e){console.error("Save error:",e.message);}
}

async function getHistory(period){
  if(!db)return trades;
  try{
    var q="SELECT * FROM trades WHERE 1=1";
    if(period==="today")q+=" AND created_at::date=CURRENT_DATE";
    else if(period==="week")q+=" AND created_at>=NOW()-INTERVAL '7 days'";
    else if(period==="month")q+=" AND created_at>=NOW()-INTERVAL '30 days'";
    q+=" ORDER BY created_at DESC LIMIT 200";
    var res=await db.query(q);
    return res.rows.map(function(r){return{id:r.order_id,symbol:r.symbol,side:r.side,qty:r.qty,price:parseFloat(r.price||0),pnl:parseFloat(r.pnl||0),time:r.trade_time,strategy:r.strategy};});
  }catch(e){return trades;}
}

function calcRSI(arr){
  if(arr.length<14)return 50;
  var g=0,l=0;
  for(var i=arr.length-14;i<arr.length;i++){var d=arr[i]-(arr[i-1]||arr[i]);if(d>0)g+=d;else l+=Math.abs(d);}
  return 100-(100/(1+(g/(l||1))));
}

function calcVWAP(sym){
  if(!vwapVol[sym]||vwapVol[sym]===0)return prices[sym]||0;
  return vwapPrice[sym]/vwapVol[sym];
}

function updateVWAP(sym,price,vol){
  if(!vwapPrice[sym])vwapPrice[sym]=0;
  if(!vwapVol[sym])vwapVol[sym]=0;
  vwapPrice[sym]+=price*(vol||1);
  vwapVol[sym]+=(vol||1);
}

function meanRevSignal(sym,price){
  var open=dayOpen[sym];
  if(!open)return null;
  var dropPct=((price-open)/open)*100;
  var rsi=calcRSI(hist[sym]||[]);
  if(dropPct<=-2&&dropPct>=-8&&rsi<45){
    var conf=Math.min(99,Math.round(65+Math.abs(dropPct)*4));
    if(rsi<35)conf=Math.min(99,conf+10);
    return{type:"BUY",confidence:conf,reason:"MeanRev: "+Math.abs(dropPct).toFixed(1)+"% below open | RSI:"+Math.round(rsi),strategy:"MeanRev"};
  }
  if(dropPct>=-0.5&&rsi>55){
    return{type:"SELL",confidence:70,reason:"MeanRev: recovered to open",strategy:"MeanRev"};
  }
  return null;
}

function orbSignal(sym,price){
  var mao=minsAfterOpen();
  var vols=volumes[sym]||[];
  var av=vols.length>1?vols.slice(0,-1).reduce(function(a,b){return a+b;},0)/vols.length:0;
  var cv=vols[vols.length-1]||0;
  var volConfirm=av===0||cv>av*1.2;
  if(mao>=0&&mao<=30){
    if(!orHigh[sym]||price>orHigh[sym])orHigh[sym]=price;
    if(!orLow[sym]||price<orLow[sym])orLow[sym]=price;
    orSet[sym]=true;
    return null;
  }
  if(!orSet[sym]||!orHigh[sym]||!orLow[sym])return null;
  var rsi=calcRSI(hist[sym]||[]);
  if(price>orHigh[sym]*1.002&&volConfirm&&rsi<75){
    var conf=Math.min(99,Math.round(70+((price-orHigh[sym])/(orHigh[sym]-orLow[sym]||1))*20));
    return{type:"BUY",confidence:conf,reason:"ORB: break above "+orHigh[sym].toFixed(2),strategy:"ORB"};
  }
  return null;
}

function vwapSignal(sym,price){
  var vwap=calcVWAP(sym);
  if(!vwap||vwap===0)return null;
  var rsi=calcRSI(hist[sym]||[]);
  var pctFromVwap=((price-vwap)/vwap)*100;
  var vols=volumes[sym]||[];
  var av=vols.length>1?vols.slice(0,-1).reduce(function(a,b){return a+b;},0)/vols.length:0;
  var cv=vols[vols.length-1]||0;
  var volOk=av===0||cv>=av;
  if(pctFromVwap>=-1.5&&pctFromVwap<=-0.1&&rsi<55&&volOk){
    var conf=Math.min(99,Math.round(65+Math.abs(pctFromVwap)*10));
    return{type:"BUY",confidence:conf,reason:"VWAP bounce: "+pctFromVwap.toFixed(2)+"% from VWAP",strategy:"VWAP"};
  }
  if(pctFromVwap>=1.5){
    return{type:"SELL",confidence:72,reason:"VWAP extended: "+pctFromVwap.toFixed(2)+"% above VWAP",strategy:"VWAP"};
  }
  return null;
}

function momentumOk(sym,type){
  var h=hist[sym]||[];
  if(h.length<10)return true;
  var ma10=h.slice(-10).reduce(function(a,b){return a+b;},0)/10;
  var pct=((h[h.length-1]-ma10)/ma10)*100;
  if(type==="BUY")return pct>-1.5;
  if(type==="SELL")return pct<1.5;
  return true;
}

function getSignal(sym,price){
  var sig=null;
  if(MEAN_REV.indexOf(sym)>=0)sig=meanRevSignal(sym,price);
  else if(BREAKOUT.indexOf(sym)>=0)sig=orbSignal(sym,price);
  else if(VWAP_GRP.indexOf(sym)>=0)sig=vwapSignal(sym,price);
  if(sig&&!momentumOk(sym,sig.type))return null;
  return sig;
}

async function tick(){
  if(!running)return;
  if(pnl<=LOSS){running=false;clearInterval(timer);console.log("Loss limit hit");return;}
  lastTick=Date.now();
  tickCount++;
  var mao=minsAfterOpen();
  if(mao<0||mao>390)return;

  try{
    var snap=await dget("/v2/stocks/snapshots?symbols="+WL.join(",")+"&feed=iex");
    if(snap){
      Object.keys(snap).forEach(function(s){
        var d=snap[s];
        var p=d&&d.latestTrade&&d.latestTrade.p||d&&d.minuteBar&&d.minuteBar.c||d&&d.dailyBar&&d.dailyBar.c;
        var v=d&&d.minuteBar&&d.minuteBar.v||0;
        var op=d&&d.dailyBar&&d.dailyBar.o;
        if(p){
          prices[s]=p;
          if(op&&!dayOpen[s])dayOpen[s]=op;
          if(!hist[s])hist[s]=[];
          if(!hist[s].length||hist[s][hist[s].length-1]!==p){hist[s].push(p);if(hist[s].length>200)hist[s].shift();}
          if(v>0){
            if(!volumes[s])volumes[s]=[];
            volumes[s].push(v);if(volumes[s].length>100)volumes[s].shift();
            updateVWAP(s,p,v);
          }
        }
      });
    }

    if(mao>=0&&mao<2){
      WL.forEach(function(s){
        vwapPrice[s]=0;vwapVol[s]=0;
        orHigh[s]=0;orLow[s]=0;orSet[s]=false;
        dayOpen[s]=prices[s]||0;
        entryCount[s]=0;exitCount[s]=0;entryConf[s]=0;
        buyLock[s]=false;
      });
      console.log("Day reset complete");
    }

    var posArr=await aget("/v2/positions");
    var posMap={};
    if(Array.isArray(posArr))posArr.forEach(function(p){posMap[p.symbol]=p;});
    Object.keys(entryCount).forEach(function(sym){
      if(!posMap[sym]&&!buyLock[sym]){entryCount[sym]=0;exitCount[sym]=0;entryConf[sym]=0;}
    });

    sigs=[];
    for(var i=0;i<WL.length;i++){
      var sym=WL[i];
      var price=prices[sym];
      if(!price)continue;
      var sig=getSignal(sym,price);
      if(!sig)continue;
      sigs.push({symbol:sym,type:sig.type,confidence:sig.confidence,reason:sig.reason,price:price,time:now(),strategy:sig.strategy});

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

        if(unrealized>=100&&conf<75){sell=true;sellQty=sq;why="$100 quick win";entryCount[sym]=0;exitCount[sym]=0;}
        else if(unrealized>=150&&conf<85){sell=true;sellQty=sq;why="$150 quick win";entryCount[sym]=0;exitCount[sym]=0;}
        else if(unrealized>=200&&conf<90){sell=true;sellQty=sq;why="$200 quick win";entryCount[sym]=0;exitCount[sym]=0;}
        else if(sig.type==="SELL"&&sig.strategy===entryConf[sym+"_strat"]&&gp>0){sell=true;sellQty=sq;why=sig.strategy+" target";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp>=35&&exitCount[sym]<3){sell=true;sellQty=sq;why="35pct final exit";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp>=20&&exitCount[sym]<2){sell=true;sellQty=third;why="20pct scale out";exitCount[sym]=2;}
        else if(gp>=10&&exitCount[sym]<1){sell=true;sellQty=third;why="10pct scale out";exitCount[sym]=1;}
        else if(gp<=-15){sell=true;sellQty=sq;why="15pct stoploss";entryCount[sym]=0;exitCount[sym]=0;}
        else if(dh>=5&&gp<5){sell=true;sellQty=sq;why="5day limit";entryCount[sym]=0;exitCount[sym]=0;}
        else if(sig.type==="SELL"&&gp<-3&&dh>=1){sell=true;sellQty=sq;why="momentum sell";entryCount[sym]=0;exitCount[sym]=0;}

        if(sell&&sellQty>0){
          var so=await apost("/v2/orders",{symbol:sym,qty:sellQty,side:"sell",type:"market",time_in_force:"day"});
          if(so.id){
            var sp=unrealized*(sellQty/sq);
            pnl+=sp;
            var t={id:so.id,symbol:sym,side:"SELL",qty:sellQty,price:price,pnl:sp,time:now(),strategy:why};
            trades.unshift(t);if(trades.length>50)trades.pop();
            saveTrade(t);
            buyLock[sym]=false;
            console.log("SELL "+sym+" "+why+" pnl:$"+sp.toFixed(2));
          }
        }
        continue;
      }

      if(sig.type==="BUY"&&sig.confidence>=65){
        if(posMap[sym])continue;
        if(buyLock[sym])continue;
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

        // Lock immediately before placing order
        buyLock[sym]=true;
        setTimeout(function(){buyLock[sym]=false;},(sym,30000));

        var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"buy",type:"market",time_in_force:"day"});
        if(ord.id){
          entryCount[sym]++;
          entryConf[sym]=sig.confidence;
          entryConf[sym+"_strat"]=sig.strategy;
          var label=sig.strategy+" Entry "+entryCount[sym]+"/"+maxEntry;
          var bt={id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:now(),strategy:label};
          trades.unshift(bt);if(trades.length>50)trades.pop();
          saveTrade(bt);
          console.log("BUY "+sym+" "+label+" conf:"+sig.confidence+"%");
        } else {
          buyLock[sym]=false;
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
  console.log("Bot started - hybrid strategy");
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
  var h=await getHistory(period);
  res.json({trades:h});
});

app.get("/signals",function(req,res){res.json({signals:sigs});});
app.get("/prices",function(req,res){res.json({prices:prices});});
app.all("/bot/start",function(req,res){startBot();res.json({ok:true,botRunning:true});});
app.all("/bot/stop",function(req,res){stopBot();res.json({ok:true,botRunning:false});});

app.post("/sell/all",async function(req,res){
  try{
    var posArr=await aget("/v2/positions");
    if(!Array.isArray(posArr)||posArr.length===0)return res.json({ok:true,message:"No positions to sell"});
    var results=[];
    for(var i=0;i<posArr.length;i++){
      var p=posArr[i];
      var qty=Math.abs(parseInt(p.qty));
      var ord=await apost("/v2/orders",{symbol:p.symbol,qty:qty,side:"sell",type:"market",time_in_force:"day"});
      if(ord.id){entryCount[p.symbol]=0;exitCount[p.symbol]=0;results.push(p.symbol);}
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
    if(!pos)return res.json({ok:false,error:sym+" not found in positions"});
    var qty=Math.abs(parseInt(pos.qty));
    var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"market",time_in_force:"day"});
    if(ord.id){entryCount[sym]=0;exitCount[sym]=0;res.json({ok:true,orderId:ord.id});}
    else res.json({ok:false,error:JSON.stringify(ord)});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});



app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});

var PORT=process.env.PORT||3000;
app.listen(PORT,async function(){
  console.log("APEX TRADE HYBRID port "+PORT+" | "+(PAPER?"PAPER":"LIVE"));
  await setupDB();
  startBot();
  setInterval(function(){
    fetch("https://apextrade-bot.onrender.com/ping")
      .then(function(r){return r.json();})
      .then(function(d){if(!d.running){startBot();}})
      .catch(function(e){console.log("Ping:"+e.message);});
  },30000);
  setInterval(function(){
    if(running&&(Date.now()-lastTick)/1000>60){startBot();}
  },120000);
});
