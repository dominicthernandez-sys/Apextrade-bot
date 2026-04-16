const express = require("express");
const path = require("path");
const crypto = require("crypto");
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const AKEY = process.env.ALPACA_KEY_ID;
const ASECRET = process.env.ALPACA_SECRET_KEY;
const PAPER = process.env.PAPER_TRADING !== "false";
const ABASE = PAPER ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
const ADATA = "https://data.alpaca.markets";
const AHDR = {"APCA-API-KEY-ID":AKEY,"APCA-API-SECRET-KEY":ASECRET};
const LOSS = parseFloat(process.env.DAILY_LOSS_LIMIT || "-500");
const CB_KEY_NAME = process.env.COINBASE_KEY_NAME;
const CB_PRIVATE_KEY = (process.env.COINBASE_PRIVATE_KEY || "").replace(/\\n/g,"\n");
const CB_BASE = "https://api.coinbase.com";

const STOCKS = ["SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META","COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD"];
const CRYPTO = ["BTC-USD","ETH-USD","SOL-USD","DOGE-USD","ADA-USD"];

let running=false, pnl=0, trades=[], sigs=[], prices={}, hist={}, timer=null, entryCount={}, exitCount={};
let cPnl=0, cTrades=[], cSigs=[], cPrices={}, cHist={}, cTimer=null, cEntry={}, cExit={};

function aget(u){return fetch(ABASE+u,{headers:AHDR}).then(function(r){return r.json();});}
function apost(u,b){return fetch(ABASE+u,{method:"POST",headers:Object.assign({"Content-Type":"application/json"},AHDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}
function dget(u){return fetch(ADATA+u,{headers:AHDR}).then(function(r){return r.json();});}

function makeCBJWT(method,reqPath){
  try{
    var hdr=Buffer.from(JSON.stringify({typ:"JWT",kid:CB_KEY_NAME,nonce:crypto.randomBytes(16).toString("hex"),alg:"ES256"})).toString("base64url");
    var now=Math.floor(Date.now()/1000);
    var pay=Buffer.from(JSON.stringify({iss:"coinbase-cloud",nbf:now,exp:now+120,sub:CB_KEY_NAME,uri:method+" api.coinbase.com"+reqPath})).toString("base64url");
    var msg=hdr+"."+pay;
    var sig=crypto.createSign("SHA256").update(msg).sign({key:CB_PRIVATE_KEY,dsaEncoding:"ieee-p1363"});
    return msg+"."+sig.toString("base64url");
  }catch(e){console.error("JWT err:",e.message);return null;}
}

function cbget(p){
  var t=makeCBJWT("GET",p);
  if(!t)return Promise.resolve({});
  return fetch(CB_BASE+p,{headers:{"Authorization":"Bearer "+t,"Content-Type":"application/json"}}).then(function(r){return r.json();});
}

function cbpost(p,b){
  var t=makeCBJWT("POST",p);
  if(!t)return Promise.resolve({});
  return fetch(CB_BASE+p,{method:"POST",headers:{"Authorization":"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json();});
}

function getSig(h){
  if(!h||h.length<10)return null;
  var ma=h.slice(-10).reduce(function(a,b){return a+b;},0)/10;
  var c=h[h.length-1];
  var p=((c-ma)/ma)*100;
  if(p>0.3)return{type:"BUY",confidence:Math.min(99,Math.round(60+p*8)),reason:p.toFixed(2)+"% above MA10"};
  if(p<-0.3)return{type:"SELL",confidence:Math.min(99,Math.round(60+Math.abs(p)*8)),reason:Math.abs(p).toFixed(2)+"% below MA10"};
  return null;
}

function addPx(h,sym,p){
  if(!h[sym])h[sym]=[];
  if(!h[sym].length||h[sym][h[sym].length-1]!==p){h[sym].push(p);if(h[sym].length>50)h[sym].shift();}
}

async function tick(){
  if(!running)return;
  if(pnl<=LOSS){running=false;clearInterval(timer);return;}
  try{
    var snap=await dget("/v2/stocks/snapshots?symbols="+STOCKS.join(",")+"&feed=iex");
    if(snap){Object.keys(snap).forEach(function(s){var d=snap[s];var p=d&&d.latestTrade&&d.latestTrade.p||d&&d.minuteBar&&d.minuteBar.c||d&&d.dailyBar&&d.dailyBar.c;if(p){prices[s]=p;addPx(hist,s,p);}});}
    var posArr=await aget("/v2/positions");
    var posMap={};
    if(Array.isArray(posArr))posArr.forEach(function(p){posMap[p.symbol]=p;});
    Object.keys(entryCount).forEach(function(s){if(!posMap[s]){entryCount[s]=0;exitCount[s]=0;}});
    sigs=[];
    for(var i=0;i<STOCKS.length;i++){
      var sym=STOCKS[i];var price=prices[sym];if(!price)continue;
      var sig=getSig(hist[sym]);if(!sig)continue;
      sigs.push({symbol:sym,type:sig.type,confidence:sig.confidence,reason:sig.reason,price:price,time:new Date().toLocaleTimeString(),market:"stocks"});
      if(posMap[sym]){
        var pos=posMap[sym];var sq=Math.abs(parseInt(pos.qty));var ep=parseFloat(pos.avg_entry_price||price);
        var gp=((price-ep)/ep)*100;var dh=Math.floor((Date.now()-new Date(pos.created_at||Date.now()).getTime())/86400000);
        if(!exitCount[sym])exitCount[sym]=0;var third=Math.max(1,Math.floor(sq/3));
        var sell=false,sellQty=sq,why="";
        if(gp<=-15){sell=true;sellQty=sq;why="15pct stoploss";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp>=35&&exitCount[sym]<3){sell=true;sellQty=sq;why="35pct final exit";entryCount[sym]=0;exitCount[sym]=0;}
        else if(gp>=20&&exitCount[sym]<2){sell=true;sellQty=third;why="20pct scale out 2/3";exitCount[sym]=2;}
        else if(gp>=10&&exitCount[sym]<1){sell=true;sellQty=third;why="10pct scale out 1/3";exitCount[sym]=1;}
        else if(dh>=5&&gp<5){sell=true;sellQty=sq;why="5day limit";entryCount[sym]=0;exitCount[sym]=0;}
        else if(sig.type==="SELL"&&gp<0){sell=true;sellQty=sq;why="momentum sell";entryCount[sym]=0;exitCount[sym]=0;}
        if(sell&&sellQty>0){
          var so=await apost("/v2/orders",{symbol:sym,qty:sellQty,side:"sell",type:"market",time_in_force:"day"});
          if(so.id){var sp=parseFloat(pos.unrealized_pl||0)*(sellQty/sq);pnl+=sp;trades.unshift({id:so.id,symbol:sym,side:"SELL",qty:sellQty,price:price,pnl:sp,time:new Date().toLocaleTimeString(),strategy:why,market:"stocks"});if(trades.length>50)trades.pop();}
        }
        continue;
      }
      if(sig.type==="BUY"&&sig.confidence>=65){
        if(!entryCount[sym])entryCount[sym]=0;
        var maxE=sig.confidence>=85?3:sig.confidence>=75?2:1;
        if(entryCount[sym]>=maxE)continue;
        var acct=await aget("/v2/account");var eq=parseFloat(acct.equity||0);
        var tot=Object.keys(posMap).reduce(function(sum,k){return sum+parseFloat(posMap[k].market_value||0);},0);
        var maxExp=eq*(sig.confidence>=90?0.25:0.10);if(tot>=maxExp)continue;
        var rem=maxExp-tot;var qty=Math.max(1,Math.floor((rem/3)/price));if(qty<1)continue;
        var stp=parseFloat((price*0.85).toFixed(2));
        var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"buy",type:"market",time_in_force:"day"});
        if(ord.id){
          await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"stop",stop_price:stp,time_in_force:"gtc"});
          entryCount[sym]++;
          trades.unshift({id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:"Entry "+entryCount[sym]+"/3",market:"stocks"});
          if(trades.length>50)trades.pop();
          console.log("BUY "+sym+" Entry "+entryCount[sym]+"/3");
        }
      }
    }
  }catch(e){console.error("Stock tick:",e.message);}
}

async function cryptoTick(){
  try{
    for(var i=0;i<CRYPTO.length;i++){
      var pair=CRYPTO[i];
      try{
        var res=await cbget("/api/v3/brokerage/best_bid_ask?product_ids="+pair);
        if(res&&res.pricebooks&&res.pricebooks[0]){
          var pb=res.pricebooks[0];
          var p=parseFloat(pb.asks&&pb.asks[0]&&pb.asks[0].price||pb.bids&&pb.bids[0]&&pb.bids[0].price||0);
          if(p>0){cPrices[pair]=p;addPx(cHist,pair,p);}
        }
      }catch(e){}
    }
    var accRes=await cbget("/api/v3/brokerage/accounts");
    var cbAccounts={};
    if(accRes&&accRes.accounts){accRes.accounts.forEach(function(a){cbAccounts[a.currency]=a;});}
    var usd=parseFloat(cbAccounts["USD"]&&cbAccounts["USD"].available_balance&&cbAccounts["USD"].available_balance.value||0);
    cSigs=[];
    for(var j=0;j<CRYPTO.length;j++){
      var sym=CRYPTO[j];var price=cPrices[sym];if(!price)continue;
      var sig=getSig(cHist[sym]);if(!sig)continue;
      cSigs.push({symbol:sym,type:sig.type,confidence:sig.confidence,reason:sig.reason,price:price,time:new Date().toLocaleTimeString(),market:"crypto"});
      if(sig.type==="BUY"&&sig.confidence>=75){
        if(!cEntry[sym])cEntry[sym]=0;
        var maxE2=sig.confidence>=85?3:sig.confidence>=75?2:1;
        if(cEntry[sym]>=maxE2)continue;
        var budget=usd*(sig.confidence>=90?0.25:0.10)/3;
        if(budget<1)continue;
        var quoteSize=budget.toFixed(2);
        var coin=sym.replace("-USD","");
        var cbHolding=parseFloat(cbAccounts[coin]&&cbAccounts[coin].available_balance&&cbAccounts[coin].available_balance.value||0);
        if(cbHolding*price>usd*0.10)continue;
        var order=await cbpost("/api/v3/brokerage/orders",{
          client_order_id:crypto.randomUUID(),
          product_id:sym,
          side:"BUY",
          order_configuration:{market_market_ioc:{quote_size:quoteSize}}
        });
        if(order&&order.success){
          cEntry[sym]++;
          cTrades.unshift({id:order.order_id||Date.now().toString(),symbol:sym,side:"BUY",qty:quoteSize,price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:"Crypto Entry "+cEntry[sym]+"/3",market:"crypto"});
          if(cTrades.length>50)cTrades.pop();
          console.log("CRYPTO BUY "+sym+" $"+quoteSize);
        }
      }
      if(sig.type==="SELL"&&sig.confidence>=75){
        var coin2=sym.replace("-USD","");
        var holding=parseFloat(cbAccounts[coin2]&&cbAccounts[coin2].available_balance&&cbAccounts[coin2].available_balance.value||0);
        if(holding<=0)continue;
        if(!cExit[sym])cExit[sym]=0;
        var sellAmt=(holding/3).toFixed(8);
        if(parseFloat(sellAmt)*price<1)continue;
        var gp2=cHist[sym]&&cHist[sym].length>1?((price-cHist[sym][0])/cHist[sym][0])*100:0;
        var why2="";
        if(gp2>=35&&cExit[sym]<3){why2="35pct final exit";cExit[sym]=3;cEntry[sym]=0;}
        else if(gp2>=20&&cExit[sym]<2){why2="20pct scale out";cExit[sym]=2;sellAmt=(holding/3).toFixed(8);}
        else if(gp2>=10&&cExit[sym]<1){why2="10pct scale out";cExit[sym]=1;sellAmt=(holding/3).toFixed(8);}
        else if(gp2<=-15){why2="15pct stoploss";cEntry[sym]=0;cExit[sym]=0;}
        else continue;
        var sord=await cbpost("/api/v3/brokerage/orders",{
          client_order_id:crypto.randomUUID(),
          product_id:sym,
          side:"SELL",
          order_configuration:{market_market_ioc:{base_size:sellAmt}}
        });
        if(sord&&sord.success){
          var spnl=parseFloat(sellAmt)*price*(gp2/100);
          cPnl+=spnl;
          cTrades.unshift({id:sord.order_id||Date.now().toString(),symbol:sym,side:"SELL",qty:sellAmt,price:price,pnl:spnl,time:new Date().toLocaleTimeString(),strategy:why2,market:"crypto"});
          if(cTrades.length>50)cTrades.pop();
          console.log("CRYPTO SELL "+sym+" "+why2);
        }
      }
    }
  }catch(e){console.error("Crypto tick:",e.message);}
}

app.get("/ping",function(req,res){res.json({ok:true});});

app.get("/status",async function(req,res){
  try{
    var a=await aget("/v2/account");
    var p=await aget("/v2/positions");
    res.json({
      botRunning:running,paper:PAPER,
      equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),
      dailyPnL:pnl,cryptoPnL:cPnl,
      positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}) :[]
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.all("/bot/start",function(req,res){
  if(!running){running=true;timer=setInterval(tick,10000);tick();}
  if(!cTimer){cTimer=setInterval(cryptoTick,15000);cryptoTick();}
  res.json({ok:true,botRunning:running});
});

app.all("/bot/stop",function(req,res){
  running=false;if(timer){clearInterval(timer);timer=null;}
  if(cTimer){clearInterval(cTimer);cTimer=null;}
  res.json({ok:true,botRunning:running});
});

app.get("/trades",function(req,res){res.json({trades:trades.concat(cTrades).sort(function(a,b){return b.time>a.time?1:-1;}).slice(0,50)});});
app.get("/signals",function(req,res){res.json({signals:sigs.concat(cSigs)});});
app.get("/prices",function(req,res){res.json({prices:Object.assign({},prices,cPrices)});});
app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});

var PORT=process.env.PORT||3000;
app.listen(PORT,function(){
  console.log("APEX TRADE port "+PORT+" PAPER="+PAPER);
  running=true;timer=setInterval(tick,10000);tick();
  cTimer=setInterval(cryptoTick,15000);cryptoTick();
  setInterval(function(){fetch("https://apextrade-bot.onrender.com/ping").catch(function(){});},600000);
  setInterval(function(){if(!running){running=true;timer=setInterval(tick,10000);tick();}if(!cTimer){cTimer=setInterval(cryptoTick,15000);cryptoTick();}},3600000);
});
