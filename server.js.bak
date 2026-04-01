const express = require(“express”);
const path = require(“path”);
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const KEY = process.env.ALPACA_KEY_ID;
const SECRET = process.env.ALPACA_SECRET_KEY;
const PAPER = process.env.PAPER_TRADING !== “false”;
const BASE = PAPER ? “https://paper-api.alpaca.markets” : “https://api.alpaca.markets”;
const DATA = “https://data.alpaca.markets”;
const LOSS = parseFloat(process.env.DAILY_LOSS_LIMIT || “-200”);
const WL = [“SPY”,“NVDA”,“AAPL”,“MSFT”,“QQQ”,“TSLA”,“AMZN”,“GOOGL”,“META”,“COIN”,“MSTR”,“AMD”,“PLTR”,“RIVN”,“SOFI”,“MARA”,“HOOD”];
const HDR = {“APCA-API-KEY-ID”:KEY,“APCA-API-SECRET-KEY”:SECRET};

let running=false, pnl=0, trades=[], sigs=[], prices={}, hist={}, timer=null;

function get(url){return fetch(url,{headers:HDR}).then(function(r){return r.json();});}
function post(url,b){return fetch(url,{method:“POST”,headers:Object.assign({“Content-Type”:“application/json”},HDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}

function signal(sym){
var h=hist[sym];
if(!h||h.length<10)return null;
var ma=h.slice(-10).reduce(function(a,b){return a+b;},0)/10;
var c=h[h.length-1];
var p=((c-ma)/ma)*100;
if(p>0.5)return{type:“BUY”,confidence:Math.min(99,Math.round(60+p*8)),reason:p.toFixed(2)+”% above MA10”};
if(p<-0.5)return{type:“SELL”,confidence:Math.min(99,Math.round(60+Math.abs(p)*8)),reason:Math.abs(p).toFixed(2)+”% below MA10”};
return null;
}

async function tick(){
if(!running)return;
if(pnl<=LOSS){running=false;clearInterval(timer);return;}
try{
var bars=await get(DATA+”/v2/stocks/bars/latest?symbols=”+WL.join(”,”)+”&feed=iex”);
if(bars.bars){
Object.keys(bars.bars).forEach(function(s){
prices[s]=bars.bars[s].c;
if(!hist[s])hist[s]=[];
hist[s].push(bars.bars[s].c);
if(hist[s].length>50)hist[s].shift();
});
}
var posArr=await get(BASE+”/v2/positions”);
var posMap={};
if(Array.isArray(posArr))posArr.forEach(function(p){posMap[p.symbol]=p;});

```
sigs=[];
for(var i=0;i<WL.length;i++){
  var sym=WL[i];
  var price=prices[sym];
  if(!price)continue;
  var sig=signal(sym);
  if(!sig)continue;
  sigs.push({symbol:sym,type:sig.type,confidence:sig.confidence,reason:sig.reason,price:price,time:new Date().toLocaleTimeString()});

  // Handle open positions - check exit rules
  if(posMap[sym]){
    var pos=posMap[sym];
    var sq=Math.abs(parseInt(pos.qty));
    var entryPrice=parseFloat(pos.avg_entry_price||price);
    var gainPct=((price-entryPrice)/entryPrice)*100;
    var daysHeld=Math.floor((Date.now()-new Date(pos.created_at||Date.now()).getTime())/86400000);
    var shouldSell=false;
    var sellQty=sq;
    var reason="";

    if(gainPct>=35){shouldSell=true;sellQty=sq;reason="35pct profit target";}
    else if(gainPct>=20){shouldSell=true;sellQty=Math.floor(sq/2);reason="20pct partial profit";}
    else if(gainPct<=-15){shouldSell=true;sellQty=sq;reason="15pct stop loss";}
    else if(daysHeld>=5&&gainPct<5){shouldSell=true;sellQty=sq;reason="5 day time limit";}
    else if(sig.type==="SELL"&&gainPct<0){shouldSell=true;sellQty=sq;reason="momentum sell";}

    if(shouldSell&&sellQty>0){
      var so=await post(BASE+"/v2/orders",{symbol:sym,qty:sellQty,side:"sell",type:"market",time_in_force:"day"});
      if(so.id){
        var sp=parseFloat(pos.unrealized_pl||0)*(sellQty/sq);
        pnl+=sp;
        trades.unshift({id:so.id,symbol:sym,side:"SELL",qty:sellQty,price:price,pnl:sp,time:new Date().toLocaleTimeString(),strategy:reason});
        if(trades.length>50)trades.pop();
      }
    }
    continue;
  }

  // Handle new buys
  if(sig.type==="BUY"&&sig.confidence>=65){
    var acct=await get(BASE+"/v2/account");
    var equity=parseFloat(acct.equity||0);
    var totalExposure=Object.keys(posMap).reduce(function(sum,s){return sum+parseFloat(posMap[s].market_value||0);},0);
    var maxExposure=equity*(sig.confidence>=90?0.25:0.10);
    if(totalExposure>=maxExposure)continue;
    var remainingBudget=maxExposure-totalExposure;
    var qty=Math.max(1,Math.floor(remainingBudget/price));
    var stopPrice=parseFloat((price*0.85).toFixed(2));
    var ord=await post(BASE+"/v2/orders",{symbol:sym,qty:qty,side:"buy",type:"market",time_in_force:"day"});
    if(ord.id){
      await post(BASE+"/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"stop",stop_price:stopPrice,time_in_force:"gtc"});
      trades.unshift({id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:"Momentum MA10"});
      if(trades.length>50)trades.pop();
    }
  }
}
```

}catch(e){console.error(e.message);}
}

app.get(”/status”,async function(req,res){
try{
var a=await get(BASE+”/v2/account”);
var p=await get(BASE+”/v2/positions”);
res.json({botRunning:running,paper:PAPER,equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),dailyPnL:pnl,positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}) :[]});
}catch(e){res.status(500).json({error:e.message});}
});

app.all(”/bot/start”,function(req,res){
if(!running){running=true;timer=setInterval(tick,60000);tick();}
res.json({ok:true,botRunning:running});
});

app.all(”/bot/stop”,function(req,res){
running=false;if(timer){clearInterval(timer);timer=null;}
res.json({ok:true,botRunning:running});
});

app.get(”/trades”,function(req,res){res.json({trades:trades});});
app.get(”/signals”,function(req,res){res.json({signals:sigs});});
app.get(”/prices”,function(req,res){res.json({prices:prices});});
app.get(”/ping”,function(req,res){res.json({ok:true});});
app.get(”/”,function(req,res){res.sendFile(path.join(__dirname,“index.html”));});

var PORT=process.env.PORT||3000;
app.listen(PORT,function(){
console.log(“APEX TRADE port “+PORT+” PAPER=”+PAPER);
setInterval(function(){fetch(“https://apextrade-bot.onrender.com/ping”).catch(function(){});},600000);
setInterval(function(){if(!running){running=true;timer=setInterval(tick,60000);tick();console.log(“Auto-restarted”);}},3600000);
});
