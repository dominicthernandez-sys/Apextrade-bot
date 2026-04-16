const express = require("express");
const path = require("path");
const crypto = require("crypto");
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Alpaca ────────────────────────────────────────────────────────────────────
const AKEY = process.env.ALPACA_KEY_ID;
const ASECRET = process.env.ALPACA_SECRET_KEY;
const PAPER = process.env.PAPER_TRADING !== "false";
const ABASE = PAPER ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
const ADATA = "https://data.alpaca.markets";
const AHDR = {"APCA-API-KEY-ID":AKEY,"APCA-API-SECRET-KEY":ASECRET};

// ── Coinbase ──────────────────────────────────────────────────────────────────
const CB_KEY = process.env.COINBASE_API_KEY;
const CB_SECRET = process.env.COINBASE_PRIVATE_KEY;
const CB_BASE = "https://api.coinbase.com";

// ── Config ────────────────────────────────────────────────────────────────────
const LOSS = parseFloat(process.env.DAILY_LOSS_LIMIT || "-200");
const STOCK_WL = ["SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META","COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD","SOUN","IONQ","RGTI","QUBT","SMCI","ARM","AVGO","MU","CVNA","UBER","LYFT","DASH"];
const CRYPTO_WL = ["BTC-USD","ETH-USD","SOL-USD","DOGE-USD","AVAX-USD"];

// ── State ─────────────────────────────────────────────────────────────────────
let running=false, pnl=0, trades=[], sigs=[], prices={}, hist={}, timer=null;
let entryCount={}, exitCount={};
let cryptoRunning=false, cryptoPnl=0, cryptoTrades=[], cryptoSigs=[];
let cryptoPrices={}, cryptoHist={}, cryptoTimer=null;
let cryptoEntryCount={}, cryptoExitCount={};

// ── Alpaca helpers ────────────────────────────────────────────────────────────
function aget(u){return fetch(ABASE+u,{headers:AHDR}).then(function(r){return r.json();});}
function apost(u,b){return fetch(ABASE+u,{method:"POST",headers:Object.assign({"Content-Type":"application/json"},AHDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}
function dget(u){return fetch(ADATA+u,{headers:AHDR}).then(function(r){return r.json();});}

// ── Coinbase JWT ──────────────────────────────────────────────────────────────
function cbJWT(method,p){
  try{
    var header=Buffer.from(JSON.stringify({alg:"ES256",kid:CB_KEY})).toString("base64url");
    var now=Math.floor(Date.now()/1000);
    var payload=Buffer.from(JSON.stringify({iss:"coinbase-cloud",nbf:now,exp:now+120,sub:CB_KEY,uri:method+" "+CB_BASE+p})).toString("base64url");
    var si=header+"."+payload;
    var key=crypto.createPrivateKey({key:CB_SECRET.replace(/\\n/g,"\n"),format:"pem"});
    var sig=crypto.sign("SHA256",Buffer.from(si),{key,dsaEncoding:"ieee-p1363"});
    return header+"."+payload+"."+sig.toString("base64url");
  }catch(e){console.error("JWT:",e.message);return null;}
}
function cbget(p){var t=cbJWT("GET",p);if(!t)return Promise.resolve({});return fetch(CB_BASE+p,{headers:{"Authorization":"Bearer "+t,"Content-Type":"application/json"}}).then(function(r){return r.
function cbpublic(pair){return fetch("https://api.coinbase.com/v2/prices/"+pair+"/spot").then(function(r){return r.json();});}
function cbpost(p,b){var t=cbJWT("POST",p);if(!t)return Promise.resolve({});return fetch(CB_BASE+p,{method:"POST",headers:{"Authorization":"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json();});}

// ── Signal ────────────────────────────────────────────────────────────────────
function getSig(h){
  if(!h||h.length<10)return null;
  var ma=h.slice(-10).reduce(function(a,b){return a+b;},0)/10;
  var c=h[h.length-1];
  var p=((c-ma)/ma)*100;
  if(p>0.3)return{type:"BUY",confidence:Math.min(99,Math.round(60+p*8)),reason:p.toFixed(2)+"% above MA10"};
  if(p<-0.3)return{type:"SELL",confidence:Math.min(99,Math.round(60+Math.abs(p)*8)),reason:Math.abs(p).toFixed(2)+"% below MA10"};
  return null;
}

// ── P&L calculator ────────────────────────────────────────────────────────────
function calcPnL(tradeList, period){
  var now=Date.now();
  var cutoff=period==="today"?new Date().setHours(0,0,0,0):period==="week"?now-7*86400000:period==="month"?now-30*86400000:0;
  var filtered=tradeList.filter(function(t){return t.side==="SELL"&&t.pnl!=null&&new Date(t.timestamp||now).getTime()>=cutoff;});
  var total=filtered.reduce(function(a,t){return a+(t.pnl||0);},0);
  var wins=filtered.filter(function(t){return t.pnl>0;}).length;
  var losses=filtered.filter(function(t){return t.pnl<=0;}).length;
  return{total:parseFloat(total.toFixed(2)),wins,losses};
}

// ── Stock tick ────────────────────────────────────────────────────────────────
async function tick(){
  if(!running)return;
  if(pnl<=LOSS){running=false;clearInterval(timer);return;}
  try{
    var snap=await dget("/v2/stocks/snapshots?symbols="+STOCK_WL.join(",")+"&feed=iex");
    if(snap){
      Object.keys(snap).forEach(function(s){
        var d=snap[s];
        var p=d&&d.latestTrade&&d.latestTrade.p||d&&d.minuteBar&&d.minuteBar.c||d&&d.dailyBar&&d.dailyBar.c;
        if(p){prices[s]=p;if(!hist[s])hist[s]=[];if(!hist[s].length||hist[s][hist[s].length-1]!==p){hist[s].push(p);if(hist[s].length>50)hist[s].shift();}}
      });
    }
    var posArr=await aget("/v2/positions");
    var posMap={};
    if(Array.isArray(posArr))posArr.forEach(function(p){posMap[p.symbol]=p;});
    Object.keys(entryCount).forEach(function(sym){if(!posMap[sym]){entryCount[sym]=0;exitCount[sym]=0;}});
    sigs=[];
    for(var i=0;i<STOCK_WL.length;i++){
      var sym=STOCK_WL[i];
      var price=prices[sym];
      if(!price)continue;
      var sig=getSig(hist[sym]);
      if(!sig)continue;
      sigs.push({symbol:sym,type:sig.type,confidence:sig.confidence,reason:sig.reason,price:price,time:new Date().toLocaleTimeString()});
      if(posMap[sym]){
        var pos=posMap[sym];
        var sq=Math.abs(parseInt(pos.qty));
        var ep=parseFloat(pos.avg_entry_price||price);
        var gp=((price-ep)/ep)*100;
        var dh=Math.floor((Date.now()-new Date(pos.created_at||Date.now()).getTime())/86400000);
        if(!exitCount[sym])exitCount[sym]=0;
        var third=Math.max(1,Math.floor(sq/3));
        var sell=false,sellQty=sq,why="";
        if(gp<=-15){sell=true;sellQty=sq;why="15pct stoploss";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp>=35&&exitCount[sym]<3){sell=true;sellQty=sq;why="35pct final exit";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp>=20&&exitCount[sym]<2){sell=true;sellQty=third;why="20pct scale out 2/3";exitCount[sym]=2;}
        else if(gp>=10&&exitCount[sym]<1){sell=true;sellQty=third;why="10pct scale out 1/3";exitCount[sym]=1;}
        else if(dh>=5&&gp<5){sell=true;sellQty=sq;why="5day limit";entryCount[sym]=0;exitCount[sym]=0;}
        else if(sig.type==="SELL"&&gp<0){sell=true;sellQty=sq;why="momentum sell";entryCount[sym]=0;exitCount[sym]=0;}
        if(sell&&sellQty>0){
          var so=await apost("/v2/orders",{symbol:sym,qty:sellQty,side:"sell",type:"market",time_in_force:"day"});
          if(so.id){var sp=parseFloat(pos.unrealized_pl||0)*(sellQty/sq);pnl+=sp;trades.unshift({id:so.id,symbol:sym,side:"SELL",qty:sellQty,price:price,pnl:sp,time:new Date().toLocaleTimeString(),timestamp:Date.now(),strategy:why});if(trades.length>200)trades.pop();}
        }
        continue;
      }
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
        var sp2=parseFloat((price*0.85).toFixed(2));
        var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"buy",type:"market",time_in_force:"day"});
        if(ord.id){
          await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"stop",stop_price:sp2,time_in_force:"gtc"});
          entryCount[sym]++;
          var label="Entry "+entryCount[sym]+"/3";
          trades.unshift({id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:new Date().toLocaleTimeString(),timestamp:Date.now(),strategy:label});
          if(trades.length>200)trades.pop();
          console.log("BUY "+sym+" "+label);
        }
      }
    }
  }catch(e){console.error("Stock tick:",e.message);}
}

// ── Crypto tick ───────────────────────────────────────────────────────────────
async function cryptoTick(){
  if(!cryptoRunning)return;
  try{
    for(var i=0;i<CRYPTO_WL.length;i++){
      var pair=CRYPTO_WL[i];
      try{
        var ticker=await cbpublic(pair);
        if(ticker&&ticker.data&&ticker.data.amount){
          var p=parseFloat(ticker.data.amount||0);
          if(p>0){cryptoPrices[pair]=p;if(!cryptoHist[pair])cryptoHist[pair]=[];if(!cryptoHist[pair].length||cryptoHist[pair][cryptoHist[pair].length-1]!==p){cryptoHist[pair].push(p);if(cryptoHist[pair].length>50)cryptoHist[pair].shift();}}
        }
      }catch(e){}
    }
    var accts=await cbget("/api/v3/brokerage/accounts");
    var usdBal=0;
    if(accts&&accts.accounts){accts.accounts.forEach(function(a){if(a.currency==="USD")usdBal=parseFloat(a.available_balance&&a.available_balance.value||0);});}
    cryptoSigs=[];
    for(var j=0;j<CRYPTO_WL.length;j++){
      var pair=CRYPTO_WL[j];
      var price=cryptoPrices[pair];
      if(!price)continue;
      var sig=getSig(cryptoHist[pair]);
      if(!sig)continue;
      cryptoSigs.push({symbol:pair,type:sig.type,confidence:sig.confidence,reason:sig.reason,price:price,time:new Date().toLocaleTimeString()});
      if(sig.type==="BUY"&&sig.confidence>=65){
        if(!cryptoEntryCount[pair])cryptoEntryCount[pair]=0;
        var maxEntry=sig.confidence>=85?3:sig.confidence>=75?2:1;
        if(cryptoEntryCount[pair]>=maxEntry)continue;
        var maxExp=usdBal*(sig.confidence>=90?0.25:0.10);
        var spend=maxExp/3;
        if(spend<1)continue;
        var order=await cbpost("/api/v3/brokerage/orders",{client_order_id:Date.now().toString(),product_id:pair,side:"BUY",order_configuration:{market_market_ioc:{quote_size:spend.toFixed(2)}}});
        if(order&&order.success){cryptoEntryCount[pair]++;var label="Entry "+cryptoEntryCount[pair]+"/3";cryptoTrades.unshift({id:order.order_id||Date.now(),symbol:pair,side:"BUY",qty:(spend/price).toFixed(6),price:price,pnl:null,time:new Date().toLocaleTimeString(),timestamp:Date.now(),strategy:label});if(cryptoTrades.length>200)cryptoTrades.pop();console.log("CRYPTO BUY "+pair+" "+label);}
      }
    }
  }catch(e){console.error("Crypto tick:",e.message);}
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/ping",function(req,res){res.json({ok:true});});
app.get("/debug/crypto",async function(req,res){
  try{
    var result=await cbget("/api/v3/brokerage/products/BTC-USD");
    res.json({ok:true,result:result});
  }catch(e){res.json({ok:false,error:e.message});}
});
app.get("/status",async function(req,res){
  try{
    var a=await aget("/v2/account");
    var p=await aget("/v2/positions");
    res.json({botRunning:running,paper:PAPER,equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),dailyPnL:pnl,cryptoPnL:cryptoPnl,cryptoRunning:cryptoRunning,positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}) :[]});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/pnl",function(req,res){
  var allTrades=trades.concat(cryptoTrades);
  res.json({today:calcPnL(allTrades,"today"),week:calcPnL(allTrades,"week"),month:calcPnL(allTrades,"month")});
});

app.get("/trades",function(req,res){
  var period=req.query.period||"today";
  var allTrades=trades.concat(cryptoTrades).sort(function(a,b){return (b.timestamp||0)-(a.timestamp||0);});
  var now=Date.now();
  var cutoff=period==="today"?new Date().setHours(0,0,0,0):period==="week"?now-7*86400000:period==="month"?now-30*86400000:0;
  var filtered=period==="all"?allTrades:allTrades.filter(function(t){return(t.timestamp||now)>=cutoff;});
  res.json({trades:filtered.slice(0,100)});
});

app.get("/signals",function(req,res){res.json({signals:sigs.concat(cryptoSigs)});});
app.get("/prices",function(req,res){res.json({prices:Object.assign({},prices,cryptoPrices)});});

app.all("/bot/start",function(req,res){
  if(!running){running=true;timer=setInterval(tick,10000);tick();}
  if(!cryptoRunning){cryptoRunning=true;cryptoTimer=setInterval(cryptoTick,10000);cryptoTick();}
  res.json({ok:true,botRunning:running,cryptoRunning:cryptoRunning});
});

app.all("/bot/stop",function(req,res){
  running=false;if(timer){clearInterval(timer);timer=null;}
  cryptoRunning=false;if(cryptoTimer){clearInterval(cryptoTimer);cryptoTimer=null;}
  res.json({ok:true,botRunning:running});
});

app.post("/sell/:sym",async function(req,res){
  try{
    var sym=req.params.sym.toUpperCase();
    var posArr=await aget("/v2/positions");
    var pos=Array.isArray(posArr)?posArr.find(function(p){return p.symbol===sym;}):null;
    if(!pos)return res.json({ok:false,error:"Position not found"});
    var qty=Math.abs(parseInt(pos.qty));
    var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"market",time_in_force:"day"});
    if(ord.id){
      var sp=parseFloat(pos.unrealized_pl||0);
      pnl+=sp;
      trades.unshift({id:ord.id,symbol:sym,side:"SELL",qty:qty,price:parseFloat(pos.current_price||0),pnl:sp,time:new Date().toLocaleTimeString(),timestamp:Date.now(),strategy:"manual sell"});
      entryCount[sym]=0;exitCount[sym]=0;
      res.json({ok:true});
    } else {
      res.json({ok:false,error:ord.message||"Order failed"});
    }
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post("/sell/all",async function(req,res){
  try{
    var posArr=await aget("/v2/positions");
    if(!Array.isArray(posArr)||posArr.length===0)return res.json({ok:true,message:"No positions"});
    var results=[];
    for(var i=0;i<posArr.length;i++){
      var pos=posArr[i];
      var qty=Math.abs(parseInt(pos.qty));
      var ord=await apost("/v2/orders",{symbol:pos.symbol,qty:qty,side:"sell",type:"market",time_in_force:"day"});
      if(ord.id){
        var sp=parseFloat(pos.unrealized_pl||0);
        pnl+=sp;
        trades.unshift({id:ord.id,symbol:pos.symbol,side:"SELL",qty:qty,price:parseFloat(pos.current_price||0),pnl:sp,time:new Date().toLocaleTimeString(),timestamp:Date.now(),strategy:"manual sell all"});
        entryCount[pos.symbol]=0;exitCount[pos.symbol]=0;
        results.push(pos.symbol);
      }
    }
    res.json({ok:true,sold:results});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});

// ── Start ─────────────────────────────────────────────────────────────────────
var PORT=process.env.PORT||3000;
app.listen(PORT,function(){
  console.log("APEX TRADE port "+PORT+" | "+(PAPER?"PAPER":"LIVE")+" | Crypto: ON");
  running=true;timer=setInterval(tick,10000);tick();
  cryptoRunning=true;cryptoTimer=setInterval(cryptoTick,10000);cryptoTick();
  setInterval(function(){fetch("https://apextrade-bot.onrender.com/ping").catch(function(){});},600000);
  setInterval(function(){
    if(!running){running=true;timer=setInterval(tick,10000);tick();}
    if(!cryptoRunning){cryptoRunning=true;cryptoTimer=setInterval(cryptoTick,10000);cryptoTick();}
  },3600000);
});
