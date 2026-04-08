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
const WL = ["SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META","COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD"];
const HDR = {"APCA-API-KEY-ID":KEY,"APCA-API-SECRET-KEY":SECRET};

let running=false, pnl=0, trades=[], sigs=[], prices={}, hist={}, timer=null;
let entryCount={}, exitCount={};

function aget(u){return fetch(BASE+u,{headers:HDR}).then(function(r){return r.json();});}
function apost(u,b){return fetch(BASE+u,{method:"POST",headers:Object.assign({"Content-Type":"application/json"},HDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}
function dget(u){return fetch(DATA+u,{headers:HDR}).then(function(r){return r.json();});}

function getSig(sym){
  var h=hist[sym];
  if(!h||h.length<10)return null;
  var ma=h.slice(-10).reduce(function(a,b){return a+b;},0)/10;
  var c=h[h.length-1];
  var p=((c-ma)/ma)*100;
  if(p>0.3)return{type:"BUY",confidence:Math.min(99,Math.round(60+p*8)),reason:p.toFixed(2)+"% above MA10"};
  if(p<-0.3)return{type:"SELL",confidence:Math.min(99,Math.round(60+Math.abs(p)*8)),reason:Math.abs(p).toFixed(2)+"% below MA10"};
  return null;
}

async function tick(){
  if(!running)return;
  if(pnl<=LOSS){running=false;clearInterval(timer);console.log("Loss limit hit");return;}
  try{
    // Get live prices via snapshots
    var snap=await dget("/v2/stocks/snapshots?symbols="+WL.join(",")+"&feed=iex");
    if(snap){
      Object.keys(snap).forEach(function(s){
        var d=snap[s];
        var p=d&&d.latestTrade&&d.latestTrade.p||d&&d.minuteBar&&d.minuteBar.c||d&&d.dailyBar&&d.dailyBar.c;
        if(p){
          prices[s]=p;
          if(!hist[s])hist[s]=[];
          if(!hist[s].length||hist[s][hist[s].length-1]!==p){
            hist[s].push(p);
            if(hist[s].length>50)hist[s].shift();
          }
        }
      });
    }

    // Get current positions
    var posArr=await aget("/v2/positions");
    var posMap={};
    if(Array.isArray(posArr))posArr.forEach(function(p){posMap[p.symbol]=p;});

    // Reset entry/exit counts for symbols no longer held
    Object.keys(entryCount).forEach(function(sym){
      if(!posMap[sym]){entryCount[sym]=0;exitCount[sym]=0;}
    });

    sigs=[];
    for(var i=0;i<WL.length;i++){
      var sym=WL[i];
      var price=prices[sym];
      if(!price)continue;
      var sig=getSig(sym);
      if(!sig)continue;
      sigs.push({symbol:sym,type:sig.type,confidence:sig.confidence,reason:sig.reason,price:price,time:new Date().toLocaleTimeString()});

      // ── EXIT LOGIC ──────────────────────────────────────────────────────
      if(posMap[sym]){
        var pos=posMap[sym];
        var sq=Math.abs(parseInt(pos.qty));
        var ep=parseFloat(pos.avg_entry_price||price);
        var gp=((price-ep)/ep)*100;
        var dh=Math.floor((Date.now()-new Date(pos.created_at||Date.now()).getTime())/86400000);
        if(!exitCount[sym])exitCount[sym]=0;
        var third=Math.max(1,Math.floor(sq/3));
        var sell=false, sellQty=sq, why="";

        if(gp<=-15){
          sell=true; sellQty=sq; why="15pct stoploss";
          entryCount[sym]=0; exitCount[sym]=0;
        } else if(gp>=35&&exitCount[sym]<3){
          sell=true; sellQty=sq; why="35pct final exit";
          entryCount[sym]=0; exitCount[sym]=0;
        } else if(gp>=20&&exitCount[sym]<2){
          sell=true; sellQty=third; why="20pct scale out 2/3";
          exitCount[sym]=2;
        } else if(gp>=10&&exitCount[sym]<1){
          sell=true; sellQty=third; why="10pct scale out 1/3";
          exitCount[sym]=1;
        } else if(dh>=5&&gp<5){
          sell=true; sellQty=sq; why="5day limit";
          entryCount[sym]=0; exitCount[sym]=0;
        } else if(sig.type==="SELL"&&gp<0){
          sell=true; sellQty=sq; why="momentum sell";
          entryCount[sym]=0; exitCount[sym]=0;
        }

        if(sell&&sellQty>0){
          var so=await apost("/v2/orders",{symbol:sym,qty:sellQty,side:"sell",type:"market",time_in_force:"day"});
          if(so.id){
            var sp=parseFloat(pos.unrealized_pl||0)*(sellQty/sq);
            pnl+=sp;
            trades.unshift({id:so.id,symbol:sym,side:"SELL",qty:sellQty,price:price,pnl:sp,time:new Date().toLocaleTimeString(),strategy:why});
            if(trades.length>50)trades.pop();
          }
        }
        continue;
      }

      // ── ENTRY LOGIC ─────────────────────────────────────────────────────
      if(sig.type==="BUY"&&sig.confidence>=65){
        if(!entryCount[sym])entryCount[sym]=0;
        var maxEntry=sig.confidence>=85?3:sig.confidence>=75?2:1;
        if(entryCount[sym]>=maxEntry)continue;

        var acct=await aget("/v2/account");
        var eq=parseFloat(acct.equity||0);
        var tot=Object.keys(posMap).reduce(function(sum,k){return sum+parseFloat(posMap[k].market_value||0);},0);
        var maxExp=eq*(sig.confidence>=90?0.25:0.10);
        if(tot>=maxExp)continue;

        var rem=maxExp-tot;
        var qty=Math.max(1,Math.floor((rem/3)/price));
        if(qty<1)continue;

        var stopPrice=parseFloat((price*0.85).toFixed(2));
        var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"buy",type:"market",time_in_force:"day"});
        if(ord.id){
          await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"stop",stop_price:stopPrice,time_in_force:"gtc"});
          entryCount[sym]++;
          var label="Entry "+entryCount[sym]+"/3";
          trades.unshift({id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:label});
          if(trades.length>50)trades.pop();
          console.log("BUY "+sym+" "+label+" qty:"+qty+" conf:"+sig.confidence+"%");
        }
      }
    }
  }catch(e){console.error("Tick error:",e.message);}
}

// ── API Routes ───────────────────────────────────────────────────────────────
app.get("/ping",function(req,res){res.json({ok:true});});

app.get("/status",async function(req,res){
  try{
    var a=await aget("/v2/account");
    var p=await aget("/v2/positions");
    res.json({
      botRunning:running, paper:PAPER,
      equity:parseFloat(a.equity||0),
      cash:parseFloat(a.cash||0),
      dailyPnL:pnl,
      positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}):[]
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.all("/bot/start",function(req,res){
  if(!running){running=true;timer=setInterval(tick,10000);tick();console.log("Bot started");}
  res.json({ok:true,botRunning:running});
});

app.all("/bot/stop",function(req,res){
  running=false;
  if(timer){clearInterval(timer);timer=null;}
  console.log("Bot stopped");
  res.json({ok:true,botRunning:running});
});

app.get("/trades",function(req,res){res.json({trades:trades});});
app.get("/signals",function(req,res){res.json({signals:sigs});});
app.get("/prices",function(req,res){res.json({prices:prices});});
app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});

// ── Start Server ─────────────────────────────────────────────────────────────
var PORT=process.env.PORT||3000;
app.listen(PORT,function(){
  console.log("APEX TRADE port "+PORT+" | "+(PAPER?"PAPER":"LIVE"));
  running=true;timer=setInterval(tick,10000);tick();
  setInterval(function(){fetch("https://apextrade-bot.onrender.com/ping").catch(function(){});},600000);
  setInterval(function(){
    if(!running){running=true;timer=setInterval(tick,10000);tick();console.log("Auto-restarted");}
  },3600000);
});
