const express = require("express");
const path = require("path");
const crypto = require("crypto");
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Alpaca Config ─────────────────────────────────────────────────────────────
const AKEY = process.env.ALPACA_KEY_ID;
const ASECRET = process.env.ALPACA_SECRET_KEY;
const PAPER = process.env.PAPER_TRADING !== "false";
const ABASE = PAPER ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
const ADATA = "https://data.alpaca.markets";
const AHDR = {"APCA-API-KEY-ID":AKEY,"APCA-API-SECRET-KEY":ASECRET};

// ── Coinbase Config ───────────────────────────────────────────────────────────
const CB_KEY = process.env.COINBASE_API_KEY;
const CB_SECRET = process.env.COINBASE_PRIVATE_KEY;
const CB_BASE = "https://api.coinbase.com";

// ── Watchlists ────────────────────────────────────────────────────────────────
const LOSS = parseFloat(process.env.DAILY_LOSS_LIMIT || "-200");
const STOCK_WL = ["SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META","COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD"];
const CRYPTO_WL = ["BTC-USD","ETH-USD","SOL-USD","DOGE-USD","AVAX-USD"];

// ── State ─────────────────────────────────────────────────────────────────────
let running=false, pnl=0, trades=[], sigs=[], prices={}, hist={}, timer=null;
let entryCount={}, exitCount={};
let cryptoRunning=false, cryptoPnl=0, cryptoTrades=[], cryptoSigs=[];
let cryptoPrices={}, cryptoHist={}, cryptoTimer=null;
let cryptoEntryCount={}, cryptoExitCount={};

// ── Alpaca API ────────────────────────────────────────────────────────────────
function aget(u){return fetch(ABASE+u,{headers:AHDR}).then(function(r){return r.json();});}
function apost(u,b){return fetch(ABASE+u,{method:"POST",headers:Object.assign({"Content-Type":"application/json"},AHDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}
function dget(u){return fetch(ADATA+u,{headers:AHDR}).then(function(r){return r.json();});}

// ── Coinbase JWT Auth ─────────────────────────────────────────────────────────
function cbJWT(method, path){
  try{
    const header = Buffer.from(JSON.stringify({alg:"ES256",kid:CB_KEY})).toString("base64url");
    const now = Math.floor(Date.now()/1000);
    const payload = Buffer.from(JSON.stringify({iss:"coinbase-cloud",nbf:now,exp:now+120,sub:CB_KEY,uri:method+" "+CB_BASE+path})).toString("base64url");
    const sigInput = header+"."+payload;
    const key = crypto.createPrivateKey({key:CB_SECRET.replace(/\\n/g,"\n"),format:"pem"});
    const sig = crypto.sign("SHA256", Buffer.from(sigInput), {key,dsaEncoding:"ieee-p1363"});
    return header+"."+payload+"."+sig.toString("base64url");
  }catch(e){console.error("JWT error:",e.message);return null;}
}

function cbget(path){
  const token = cbJWT("GET",path);
  if(!token)return Promise.resolve({});
  return fetch(CB_BASE+path,{headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"}}).then(function(r){return r.json();});
}

function cbpost(path,body){
  const token = cbJWT("POST",path);
  if(!token)return Promise.resolve({});
  return fetch(CB_BASE+path,{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();});
}

// ── Signal Logic ──────────────────────────────────────────────────────────────
function getSig(h){
  if(!h||h.length<10)return null;
  var ma=h.slice(-10).reduce(function(a,b){return a+b;},0)/10;
  var c=h[h.length-1];
  var p=((c-ma)/ma)*100;
  if(p>0.3)return{type:"BUY",confidence:Math.min(99,Math.round(60+p*8)),reason:p.toFixed(2)+"% above MA10"};
  if(p<-0.3)return{type:"SELL",confidence:Math.min(99,Math.round(60+Math.abs(p)*8)),reason:Math.abs(p).toFixed(2)+"% below MA10"};
  return null;
}

// ── Stock Bot Tick ────────────────────────────────────────────────────────────
async function tick(){
  if(!running)return;
  if(pnl<=LOSS){running=false;clearInterval(timer);console.log("Stock loss limit hit");return;}
  try{
    var snap=await dget("/v2/stocks/snapshots?symbols="+STOCK_WL.join(",")+"&feed=iex");
    if(snap){
      Object.keys(snap).forEach(function(s){
        var d=snap[s];
        var p=d&&d.latestTrade&&d.latestTrade.p||d&&d.minuteBar&&d.minuteBar.c||d&&d.dailyBar&&d.dailyBar.c;
        if(p){
          prices[s]=p;
          if(!hist[s])hist[s]=[];
          if(!hist[s].length||hist[s][hist[s].length-1]!==p){hist[s].push(p);if(hist[s].length>50)hist[s].shift();}
        }
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
          if(so.id){var sp=parseFloat(pos.unrealized_pl||0)*(sellQty/sq);pnl+=sp;trades.unshift({id:so.id,symbol:sym,side:"SELL",qty:sellQty,price:price,pnl:sp,time:new Date().toLocaleTimeString(),strategy:why});if(trades.length>50)trades.pop();}
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
          trades.unshift({id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:label});
          if(trades.length>50)trades.pop();
          console.log("STOCK BUY "+sym+" "+label);
        }
      }
    }
  }catch(e){console.error("Stock tick error:",e.message);}
}

// ── Crypto Bot Tick ───────────────────────────────────────────────────────────
async function cryptoTick(){
  if(!cryptoRunning)return;
  try{
    for(var i=0;i<CRYPTO_WL.length;i++){
      var pair=CRYPTO_WL[i];
      try{
        var ticker=await cbget("/api/v3/brokerage/best_bid_ask?product_ids="+pair);
        if(ticker&&ticker.pricebooks&&ticker.pricebooks[0]){
          var p=parseFloat(ticker.pricebooks[0].bids[0].price||0);
          if(p>0){
            cryptoPrices[pair]=p;
            if(!cryptoHist[pair])cryptoHist[pair]=[];
            if(!cryptoHist[pair].length||cryptoHist[pair][cryptoHist[pair].length-1]!==p){
              cryptoHist[pair].push(p);
              if(cryptoHist[pair].length>50)cryptoHist[pair].shift();
            }
          }
        }
      }catch(e){}
    }

    // Get crypto accounts
    var accts=await cbget("/api/v3/brokerage/accounts");
    var usdBalance=0;
    if(accts&&accts.accounts){
      accts.accounts.forEach(function(a){
        if(a.currency==="USD")usdBalance=parseFloat(a.available_balance&&a.available_balance.value||0);
      });
    }

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
        var maxExp=usdBalance*(sig.confidence>=90?0.25:0.10);
        var spend=maxExp/3;
        if(spend<1)continue;
        var baseSize=(spend/price).toFixed(8);
        var order=await cbpost("/api/v3/brokerage/orders",{
          client_order_id:Date.now().toString(),
          product_id:pair,
          side:"BUY",
          order_configuration:{market_market_ioc:{quote_size:spend.toFixed(2)}}
        });
        if(order&&order.success){
          cryptoEntryCount[pair]++;
          var label="Entry "+cryptoEntryCount[pair]+"/3";
          cryptoTrades.unshift({id:order.order_id||Date.now(),symbol:pair,side:"BUY",qty:baseSize,price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:label});
          if(cryptoTrades.length>50)cryptoTrades.pop();
          console.log("CRYPTO BUY "+pair+" "+label);
        }
      }
    }
  }catch(e){console.error("Crypto tick error:",e.message);}
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.get("/ping",function(req,res){res.json({ok:true});});

app.get("/status",async function(req,res){
  try{
    var a=await aget("/v2/account");
    var p=await aget("/v2/positions");
    res.json({
      botRunning:running,paper:PAPER,
      equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),
      dailyPnL:pnl,cryptoPnL:cryptoPnl,cryptoRunning:cryptoRunning,
      positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}):[]
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.all("/bot/start",function(req,res){
  if(!running){running=true;timer=setInterval(tick,10000);tick();}
  if(!cryptoRunning){cryptoRunning=true;cryptoTimer=setInterval(cryptoTick,10000);cryptoTick();}
  res.json({ok:true,botRunning:running,cryptoRunning:cryptoRunning});
});

app.all("/bot/stop",function(req,res){
  running=false;if(timer){clearInterval(timer);timer=null;}
  cryptoRunning=false;if(cryptoTimer){clearInterval(cryptoTimer);cryptoTimer=null;}
  res.json({ok:true,botRunning:running,cryptoRunning:cryptoRunning});
});

app.get("/trades",function(req,res){res.json({trades:trades.concat(cryptoTrades).sort(function(a,b){return b.id-a.id;}).slice(0,50)});});
app.get("/signals",function(req,res){res.json({signals:sigs.concat(cryptoSigs)});});
app.get("/prices",function(req,res){res.json({prices:Object.assign({},prices,cryptoPrices)});});
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
