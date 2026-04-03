const express = require("express");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

var KEY=process.env.ALPACA_KEY_ID;
var SECRET=process.env.ALPACA_SECRET_KEY;
var PAPER=process.env.PAPER_TRADING!=="false";
var BASE=PAPER?"https://paper-api.alpaca.markets":"https://api.alpaca.markets";
var DATA="https://data.alpaca.markets";
var LOSS=parseFloat(process.env.DAILY_LOSS_LIMIT||"-200");
var WL=["SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META","COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD"];
var HDR={"APCA-API-KEY-ID":KEY,"APCA-API-SECRET-KEY":SECRET};
var running=false,pnl=0,trades=[],sigs=[],prices={},hist={},timer=null;

function aget(u){return fetch(BASE+u,{headers:HDR}).then(function(r){return r.json();});}
function apost(u,b){return fetch(BASE+u,{method:"POST",headers:Object.assign({"Content-Type":"application/json"},HDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}
function dget(u){return fetch(DATA+u,{headers:HDR}).then(function(r){return r.json();});}

function sig(sym){
  var h=hist[sym];
  if(!h||h.length<10)return null;
  var ma=h.slice(-10).reduce(function(a,b){return a+b;},0)/10;
  var c=h[h.length-1];
  var p=((c-ma)/ma)*100;
  if(p>0.5)return{type:"BUY",confidence:Math.min(99,Math.round(60+p*8)),reason:p.toFixed(2)+"% above MA10"};
  if(p<-0.5)return{type:"SELL",confidence:Math.min(99,Math.round(60+Math.abs(p)*8)),reason:Math.abs(p).toFixed(2)+"% below MA10"};
  return null;
}

async function tick(){
  if(!running)return;
  if(pnl<=LOSS){running=false;clearInterval(timer);return;}
  try{
    var bars=await dget("/v2/stocks/bars/latest?symbols="+WL.join(",")+"&feed=iex");
    if(bars.bars){
      Object.keys(bars.bars).forEach(function(s){
        prices[s]=bars.bars[s].c;
        if(!hist[s])hist[s]=[];
        hist[s].push(bars.bars[s].c);
        if(hist[s].length>50)hist[s].shift();
      });
    }
    var posArr=await aget("/v2/positions");
    var posMap={};
    if(Array.isArray(posArr))posArr.forEach(function(p){posMap[p.symbol]=p;});
    sigs=[];
    for(var i=0;i<WL.length;i++){
      var sym=WL[i];
      var price=prices[sym];
      if(!price)continue;
      var s=sig(sym);
      if(!s)continue;
      sigs.push({symbol:sym,type:s.type,confidence:s.confidence,reason:s.reason,price:price,time:new Date().toLocaleTimeString()});
      if(posMap[sym]){
        var pos=posMap[sym];
        var sq=Math.abs(parseInt(pos.qty));
        var ep=parseFloat(pos.avg_entry_price||price);
        var gp=((price-ep)/ep)*100;
        var dh=Math.floor((Date.now()-new Date(pos.created_at||Date.now()).getTime())/86400000);
        var sell=false;
        var sq2=sq;
        var why="";
        if(gp>=35){sell=true;sq2=sq;why="35pct profit";}
        else if(gp>=20){sell=true;sq2=Math.floor(sq/2);why="20pct partial";}
        else if(gp<=-15){sell=true;sq2=sq;why="15pct stoploss";}
        else if(dh>=5&&gp<5){sell=true;sq2=sq;why="5day limit";}
        else if(s.type==="SELL"&&gp<0){sell=true;sq2=sq;why="momentum sell";}
        if(sell&&sq2>0){
          var so=await apost("/v2/orders",{symbol:sym,qty:sq2,side:"sell",type:"market",time_in_force:"day"});
          if(so.id){
            var sp=parseFloat(pos.unrealized_pl||0)*(sq2/sq);
            pnl+=sp;
            trades.unshift({id:so.id,symbol:sym,side:"SELL",qty:sq2,price:price,pnl:sp,time:new Date().toLocaleTimeString(),strategy:why});
            if(trades.length>50)trades.pop();
          }
        }
        continue;
      }
      if(s.type==="BUY"&&s.confidence>=65){
        var acct=await aget("/v2/account");
        var eq=parseFloat(acct.equity||0);
        var tot=Object.keys(posMap).reduce(function(sum,k){return sum+parseFloat(posMap[k].market_value||0);},0);
        var max=eq*(s.confidence>=90?0.25:0.10);
        if(tot>=max)continue;
        var rem=max-tot;
        var qty=Math.max(1,Math.floor(rem/price));
        var sp2=parseFloat((price*0.85).toFixed(2));
        var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"buy",type:"market",time_in_force:"day"});
        if(ord.id){
          await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"stop",stop_price:sp2,time_in_force:"gtc"});
          trades.unshift({id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:"Momentum MA10"});
          if(trades.length>50)trades.pop();
        }
      }
    }
  }catch(e){console.error(e.message);}
}

app.get("/ping",function(req,res){res.json({ok:true});});

app.get("/status",async function(req,res){
  try{
    var a=await aget("/v2/account");
    var p=await aget("/v2/positions");
    res.json({botRunning:running,paper:PAPER,equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),dailyPnL:pnl,positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}) :[]});
  }catch(e){res.status(500).json({error:e.message});}
});

app.all("/bot/start",function(req,res){
  if(!running){running=true;timer=setInterval(tick,60000);tick();}
  res.json({ok:true,botRunning:running});
});

app.all("/bot/stop",function(req,res){
  running=false;
  if(timer){clearInterval(timer);timer=null;}
  res.json({ok:true,botRunning:running});
});

app.get("/trades",function(req,res){res.json({trades:trades});});
app.get("/signals",function(req,res){res.json({signals:sigs});});
app.get("/prices",function(req,res){res.json({prices:prices});});
app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});

var PORT=process.env.PORT||3000;
app.listen(PORT,function(){
  console.log("APEX TRADE port "+PORT+" PAPER="+PAPER);
  running=true;timer=setInterval(tick,60000);tick();console.log("Bot auto-started");
  setInterval(function(){fetch("https://apextrade-bot.onrender.com/ping").catch(function(){});},600000);
  setInterval(function(){if(!running){running=true;timer=setInterval(tick,60000);tick();}},3600000);
});
