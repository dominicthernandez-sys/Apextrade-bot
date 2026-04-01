const express = require("express");
const path = require("path");
const app = express();
app.use(express.static(__dirname));
app.listen(process.env.PORT||3000,function(){console.log("ok");});
app.get("/ping",function(req,res){res.json({ok:true});});
var KEY=process.env.ALPACA_KEY_ID;
var SECRET=process.env.ALPACA_SECRET_KEY;
var PAPER=process.env.PAPER_TRADING!=="false";
var BASE=PAPER?"https://paper-api.alpaca.markets":"https://api.alpaca.markets";
var HDR={"APCA-API-KEY-ID":KEY,"APCA-API-SECRET-KEY":SECRET};
function aget(u){return fetch(BASE+u,{headers:HDR}).then(function(r){return r.json();});}
app.get("/status",async function(req,res){try{var a=await aget("/v2/account");var p=await aget("/v2/positions");res.json({botRunning:false,paper:PAPER,equity:parseFloat(a.equity||0),cash:parseFloat(a.cash||0),dailyPnL:0,positions:Array.isArray(p)?p.map(function(x){return{symbol:x.symbol,qty:x.qty,pnl:parseFloat(x.unrealized_pl||0),value:parseFloat(x.market_value||0)};}):[]});}catch(e){res.status(500).json({error:e.message});}});
app.all("/bot/start",function(req,res){res.json({ok:true,botRunning:true});});
app.all("/bot/stop",function(req,res){res.json({ok:true,botRunning:false});});
app.get("/trades",function(req,res){res.json({trades:[]});});
app.get("/signals",function(req,res){res.json({signals:[]});});
app.get("/prices",function(req,res){res.json({prices:{}});});
app.get("/",function(req,res){res.sendFile(path.join(__dirname,"index.html"));});
