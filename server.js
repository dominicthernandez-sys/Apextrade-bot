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
const CB_PRIVATE_KEY = (process.env.COINBASE_PRIVATE_KEY || "").replace(/\\n/g,"\n").replace(/\r/g,"");
console.log("KEY NAME:", CB_KEY_NAME ? CB_KEY_NAME.substring(0,30)+"..." : "MISSING");
console.log("PRIVATE KEY START:", CB_PRIVATE_KEY ? CB_PRIVATE_KEY.substring(0,27) : "MISSING");
const CB_BASE = "https://api.coinbase.com";

const STOCKS = ["SPY","NVDA","AAPL","MSFT","QQQ","TSLA","AMZN","GOOGL","META","COIN","MSTR","AMD","PLTR","RIVN","SOFI","MARA","HOOD","SOUN","IONQ","RGTI","QUBT","ARM","AVGO","MU","CVNA","UBER","LYFT","DASH"];
const CRYPTO = ["BTC-USD","ETH-USD","SOL-USD","DOGE-USD","ADA-USD"];

let running=false, pnl=0, trades=[], sigs=[], prices={}, hist={}, timer=null, entryCount={}, exitCount={};
let cPnl=0, cTrades=[], cSigs=[], cPrices={}, cHist={}, cTimer=null, cEntry={}, cExit={};

function aget(u){return fetch(ABASE+u,{headers:AHDR}).then(function(r){return r.json();});}
function apost(u,b){return fetch(ABASE+u,{method:"POST",headers:Object.assign({"Content-Type":"application/json"},AHDR),body:JSON.stringify(b)}).then(function(r){return r.json();});}
function dget(u){return fetch(ADATA+u,{headers:AHDR}).then(function(r){return r.json();});}

function makeCBJWT(method,reqPath){
  try{
    var now=Math.floor(Date.now()/1000);
    var header=Buffer.from(JSON.stringify({alg:"ES256",kid:CB_KEY_NAME,nonce:crypto.randomBytes(16).toString("hex")})).toString("base64url");
    var payload=Buffer.from(JSON.stringify({iss:"cdp",nbf:now,exp:now+120,sub:CB_KEY_NAME,uri:method+" api.coinbase.com"+reqPath})).toString("base64url");
    var msg=header+"."+payload;
    var keyStr=CB_PRIVATE_KEY.trim();
    var key=crypto.createPrivateKey({key:keyStr,format:"pem"}); 
    var sig=crypto.sign("sha256",Buffer.from(msg),{key:key,dsaEncoding:"ieee-p1363"});
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

function calcPnlStats(tradeList){
  var now=Date.now();
  var todayStart=new Date();todayStart.setHours(0,0,0,0);
  var weekStart=new Date();weekStart.setDate(weekStart.getDate()-7);
  var monthStart=new Date();monthStart.setDate(1);monthStart.setHours(0,0,0,0);
  function stats(filtered){
    var total=0,wins=0,losses=0;
    filtered.forEach(function(t){if(t.pnl!=null){total+=t.pnl;if(t.pnl>0)wins++;else if(t.pnl<0)losses++;}});
    return{total:parseFloat(total.toFixed(2)),wins:wins,losses:losses};
  }
  function inPeriod(t,start){var d=new Date(t.date||now);return d>=start;}
  return{
    today:stats(tradeList.filter(function(t){return inPeriod(t,todayStart);})),
    week:stats(tradeList.filter(function(t){return inPeriod(t,weekStart);})),
    month:stats(tradeList.filter(function(t){return inPeriod(t,monthStart);}))
  };
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
        var pos=posMap[sym];var sq=Math.abs(parseInt(pos.qty));
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
          if(so.id){var sp=parseFloat(pos.unrealized_pl||0)*(sellQty/sq);pnl+=sp;
            trades.unshift({id:so.id,symbol:sym,side:"SELL",qty:sellQty,price:price,pnl:sp,time:new Date().toLocaleTimeString(),strategy:why,market:"stocks",date:new Date().toISOString()});
            if(trades.length>200)trades.pop();}
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
          trades.unshift({id:ord.id,symbol:sym,side:"BUY",qty:qty,price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:"Entry "+entryCount[sym]+"/3",market:"stocks",date:new Date().toISOString()});
          if(trades.length>200)trades.pop();
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
      }catch(e){console.error("Crypto price err "+pair+":",e.message);}
    }
    var accRes=await cbget("/api/v3/brokerage/accounts");
    var cbAcc={};
    if(accRes&&accRes.accounts){accRes.accounts.forEach(function(a){cbAcc[a.currency]=a;});}
    var usd=parseFloat(cbAcc["USD"]&&cbAcc["USD"].available_balance&&cbAcc["USD"].available_balance.value||0);
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
        var coin=sym.replace("-USD","");
        var holding=parseFloat(cbAcc[coin]&&cbAcc[coin].available_balance&&cbAcc[coin].available_balance.value||0);
        if(holding*price>usd*0.10)continue;
        var order=await cbpost("/api/v3/brokerage/orders",{client_order_id:crypto.randomUUID(),product_id:sym,side:"BUY",order_configuration:{market_market_ioc:{quote_size:budget.toFixed(2)}}});
        if(order&&order.success){
          cEntry[sym]++;
          cTrades.unshift({id:order.order_id||Date.now().toString(),symbol:sym,side:"BUY",qty:budget.toFixed(2),price:price,pnl:null,time:new Date().toLocaleTimeString(),strategy:"Crypto Entry "+cEntry[sym]+"/3",market:"crypto",date:new Date().toISOString()});
          if(cTrades.length>100)cTrades.pop();
          console.log("CRYPTO BUY "+sym+" $"+budget.toFixed(2));
        }
      }
      if(sig.type==="SELL"&&sig.confidence>=75){
        var coin2=sym.replace("-USD","");
        var h2=parseFloat(cbAcc[coin2]&&cbAcc[coin2].available_balance&&cbAcc[coin2].available_balance.value||0);
        if(h2<=0)continue;
        if(!cExit[sym])cExit[sym]=0;
        var gp2=cHist[sym]&&cHist[sym].length>1?((price-cHist[sym][0])/cHist[sym][0])*100:0;
        var why2="",sellAmt=(h2/3).toFixed(8);
        if(gp2>=35&&cExit[sym]<3){why2="35pct final exit";cExit[sym]=3;cEntry[sym]=0;sellAmt=h2.toFixed(8);}
        else if(gp2>=20&&cExit[sym]<2){why2="20pct scale out";cExit[sym]=2;}
        else if(gp2>=10&&cExit[sym]<1){why2="10pct scale out";cExit[sym]=1;}
        else if(gp2<=-15){why2="15pct stoploss";cEntry[sym]=0;cExit[sym]=0;sellAmt=h2.toFixed(8);}
        else continue;
        if(parseFloat(sellAmt)*price<1)continue;
        var sord=await cbpost("/api/v3/brokerage/orders",{client_order_id:crypto.randomUUID(),product_id:sym,side:"SELL",order_configuration:{market_market_ioc:{base_size:sellAmt}}});
        if(sord&&sord.success){
          var sp2=parseFloat(sellAmt)*price*(gp2/100);cPnl+=sp2;
          cTrades.unshift({id:sord.order_id||Date.now().toString(),symbol:sym,side:"SELL",qty:sellAmt,price:price,pnl:sp2,time:new Date().toLocaleTimeString(),strategy:why2,market:"crypto",date:new Date().toISOString()});
          if(cTrades.length>100)cTrades.pop();
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
    res.json({botRunning:running,paper:PAPER,equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),dailyPnL:pnl,cryptoPnL:cPnl,positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}) :[]});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/pnl",function(req,res){
  var all=trades.concat(cTrades);
  res.json(calcPnlStats(all));
});

app.get("/trades",function(req,res){
  var period=req.query.period||"today";
  var all=trades.concat(cTrades).sort(function(a,b){return new Date(b.date||0)-new Date(a.date||0);});
  var now=Date.now();
  var filtered=all.filter(function(t){
    var d=new Date(t.date||now);
    if(period==="today"){var s=new Date();s.setHours(0,0,0,0);return d>=s;}
    if(period==="week"){return now-d.getTime()<=7*86400000;}
    if(period==="month"){var s2=new Date();s2.setDate(1);s2.setHours(0,0,0,0);return d>=s2;}
    return true;
  });
  res.json({trades:filtered});
});

app.get("/signals",function(req,res){res.json({signals:sigs.concat(cSigs)});});
app.get("/prices",function(req,res){res.json({prices:Object.assign({},prices,cPrices)});});

app.post("/sell/:symbol",async function(req,res){
  try{
    var sym=req.params.symbol.toUpperCase();
    var posArr=await aget("/v2/positions");
    var pos=Array.isArray(posArr)?posArr.find(function(p){return p.symbol===sym;}):null;
    if(!pos)return res.json({ok:false,error:"Position not found"});
    var qty=Math.abs(parseInt(pos.qty));
    var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"market",time_in_force:"day"});
    if(ord.id){
      var pv=parseFloat(pos.unrealized_pl||0);pnl+=pv;
      trades.unshift({id:ord.id,symbol:sym,side:"SELL",qty:qty,price:parseFloat(pos.current_price||0),pnl:pv,time:new Date().toLocaleTimeString(),strategy:"manual sell",market:"stocks",date:new Date().toISOString()});
      entryCount[sym]=0;exitCount[sym]=0;
      res.json({ok:true,symbol:sym,qty:qty,pnl:pv});
    }else{res.json({ok:false,error:ord.message||"Order failed"});}
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post("/sell/all",async function(req,res){
  try{
    var posArr=await aget("/v2/positions");
    if(!Array.isArray(posArr)||posArr.length===0)return res.json({ok:true,message:"No positions"});
    var results=[];
    for(var i=0;i<posArr.length;i++){
      var pos=posArr[i];var sym=pos.symbol;var qty=Math.abs(parseInt(pos.qty));
      var ord=await apost("/v2/orders",{symbol:sym,qty:qty,side:"sell",type:"market",time_in_force:"day"});
      if(ord.id){
        var pv=parseFloat(pos.unrealized_pl||0);pnl+=pv;
        trades.unshift({id:ord.id,symbol:sym,side:"SELL",qty:qty,price:parseFloat(pos.current_price||0),pnl:pv,time:new Date().toLocaleTimeString(),strategy:"manual sell all",market:"stocks",date:new Date().toISOString()});
        entryCount[sym]=0;exitCount[sym]=0;results.push(sym);
      }
    }
    res.json({ok:true,sold:results});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
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

app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});

var PORT=process.env.PORT||3000;
app.listen(PORT,function(){
  console.log("APEX TRADE port "+PORT+" PAPER="+PAPER);
  running=true;timer=setInterval(tick,10000);tick();
  cTimer=setInterval(cryptoTick,15000);cryptoTick();
  setInterval(function(){fetch("https://apextrade-bot.onrender.com/ping").catch(function(){});},600000);
  setInterval(function(){if(!running){running=true;timer=setInterval(tick,10000);tick();}if(!cTimer){cTimer=setInterval(cryptoTick,15000);cryptoTick();}},3600000);
});
