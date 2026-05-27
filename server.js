// v3 - 백그라운드 자동매매 엔진 포함
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors());
app.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const BINANCE_BASE   = "https://fapi.binance.com";
const API_KEY        = process.env.BINANCE_API_KEY    || "";
const SECRET_KEY     = process.env.BINANCE_SECRET_KEY || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || "";

// ── 자동매매 상태 ─────────────────────────────────────────────────────────────
let autoState = {
  enabled: false,
  interval: 60,        // 분석 주기 (초)
  symbols: ["BTCUSDT","ETHUSDT","SOLUSDT"],
  leverage: 10,
  marginUsdt: 10,      // 포지션당 증거금 (USDT)
  minConfidence: 75,   // 최소 확신도
  logs: [],
  lastRun: null,
  nextRun: null,
  running: false,
};
let autoTimer = null;

function addAutoLog(msg) {
  const entry = { time: new Date().toLocaleString("ko-KR"), msg };
  autoState.logs.unshift(entry);
  if (autoState.logs.length > 100) autoState.logs.pop();
  console.log("[AUTO]", msg);
}

// ── 서명 ──────────────────────────────────────────────────────────────────────
function sign(params) {
  const qs = new URLSearchParams(params).toString();
  return crypto.createHmac("sha256", SECRET_KEY).update(qs).digest("hex");
}

async function binanceFetch(path, method = "GET", params = {}, signed = false) {
  if (signed) {
    params.timestamp  = Date.now();
    params.recvWindow = 5000;
    params.signature  = sign(params);
  }
  const qs  = new URLSearchParams(params).toString();
  const url = method === "GET" ? `${BINANCE_BASE}${path}?${qs}` : `${BINANCE_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": API_KEY, ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(method !== "GET" ? { body: qs } : {}),
  });
  return res.json();
}

// ── AI 분석 함수 ──────────────────────────────────────────────────────────────
async function analyzeSymbol(symbol) {
  try {
    // 캔들 데이터
    const klines = await fetch(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=50`).then(r => r.json());
    const cl = klines.map(k => +k[4]);
    const hi = klines.map(k => +k[2]);
    const lo = klines.map(k => +k[3]);
    const vols = klines.map(k => +k[5]);
    const cur = cl[cl.length - 1];

    // 지표 계산
    const ma7  = cl.slice(-7).reduce((a,b)=>a+b,0)/7;
    const ma20 = cl.slice(-20).reduce((a,b)=>a+b,0)/20;
    let g=0,l=0;
    for(let i=cl.length-14;i<cl.length;i++){const d=cl[i]-cl[i-1];d>0?(g+=d):(l-=d);}
    const rsi = 100-100/(1+g/(l||1e-9));
    const trs = hi.slice(-14).map((h,i)=>{const idx=hi.length-14+i;return Math.max(h-lo[idx],Math.abs(h-(cl[idx-1]||cl[idx])),Math.abs(lo[idx]-(cl[idx-1]||cl[idx])));});
    const atr = trs.reduce((a,b)=>a+b,0)/trs.length;
    const avgV = vols.slice(-10).reduce((a,b)=>a+b,0)/10;
    const vSpk = vols[vols.length-1]/avgV;
    const ema12 = cl.slice(-12).reduce((a,b,i)=>i===0?b:a*(11/13)+b*(2/13),cl[cl.length-12]);
    const ema26 = cl.reduce((a,b,i)=>i===0?b:a*(25/27)+b*(2/27),cl[0]);
    const macd = ema12-ema26;

    // 현재 포지션 확인
    const positions = await binanceFetch("/fapi/v2/positionRisk","GET",{},true);
    const activePos = positions.find(p=>p.symbol===symbol&&parseFloat(p.positionAmt)!==0);

    const prompt = `당신은 바이낸스 선물 퀀트 트레이더입니다. 순수 JSON만 반환하세요.

코인: ${symbol} | 타임프레임: 15분봉 | 현재가: ${cur}
MA7: ${ma7.toFixed(4)} | MA20: ${ma20.toFixed(4)}
RSI: ${rsi.toFixed(1)} | ATR: ${atr.toFixed(4)} | MACD: ${macd.toFixed(4)}
거래량스파이크: ${vSpk.toFixed(2)}x | 최근5봉: ${cl.slice(-5).map(p=>p.toFixed(2)).join(",")}
현재포지션: ${activePos?`${parseFloat(activePos.positionAmt)>0?"LONG":"SHORT"} ${activePos.positionAmt}`:"없음"}

규칙: ATR기반 SL, RR≥1.5, 확신<70이면 HOLD, 포지션있으면 HOLD.

{"signal":"LONG|SHORT|HOLD","confidence":0-100,"entry":숫자,"stopLoss":숫자,"takeProfit":숫자,"reasoning":"한국어 1-2문장","trend":"BULLISH|BEARISH|NEUTRAL","riskLevel":"LOW|MEDIUM|HIGH"}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-sonnet-4-5", max_tokens:512, messages:[{role:"user",content:prompt}] }),
    });
    const d = await r.json();
    if(d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    const txt = d.content?.map(i=>i.text||"").join("")||"";
    return { ...JSON.parse(txt.replace(/```json|```/g,"").trim()), symbol, currentPrice: cur, activePos };
  } catch(e) {
    addAutoLog(`❌ ${symbol} 분석 오류: ${e.message}`);
    return null;
  }
}

// ── 자동매매 실행 ──────────────────────────────────────────────────────────────
async function runAutoTrade() {
  if (autoState.running) return;
  autoState.running = true;
  autoState.lastRun = new Date().toLocaleString("ko-KR");
  addAutoLog(`🔄 자동 분석 시작 (${autoState.symbols.join(", ")})`);

  for (const symbol of autoState.symbols) {
    try {
      const sig = await analyzeSymbol(symbol);
      if (!sig) continue;
      addAutoLog(`🤖 ${symbol}: ${sig.signal} ${sig.confidence}% | ${sig.reasoning}`);

      if (sig.signal === "HOLD" || sig.confidence < autoState.minConfidence) {
        addAutoLog(`⏭ ${symbol}: HOLD 또는 확신도 부족 (${sig.confidence}%)`); continue;
      }
      if (sig.activePos) {
        addAutoLog(`⏭ ${symbol}: 이미 포지션 있음`); continue;
      }

      // 주문 실행
      const side = sig.signal === "LONG" ? "BUY" : "SELL";
      const dec = symbol.includes("BTC")?1:symbol.includes("ETH")?2:3;

      await binanceFetch("/fapi/v1/leverage","POST",{symbol,leverage:autoState.leverage},true);
      try { await binanceFetch("/fapi/v1/marginType","POST",{symbol,marginType:"ISOLATED"},true); } catch(e){}

      const price = sig.currentPrice;
      const qty = (autoState.marginUsdt / price * autoState.leverage).toFixed(3);

      const order = await binanceFetch("/fapi/v1/order","POST",{symbol,side,type:"MARKET",quantity:qty,positionSide:"BOTH"},true);
      if(order.code&&order.code<0) throw new Error(order.msg);

      addAutoLog(`✅ ${sig.signal} ${symbol} x${autoState.leverage} qty:${qty} @ $${price.toFixed(dec)}`);

      // SL/TP
      if(sig.stopLoss) {
        try {
          await binanceFetch("/fapi/v1/order","POST",{symbol,side:side==="BUY"?"SELL":"BUY",type:"STOP_MARKET",stopPrice:sig.stopLoss.toFixed(dec),quantity:qty,positionSide:"BOTH",timeInForce:"GTE_GTC"},true);
          addAutoLog(`🛡 SL 설정: $${sig.stopLoss.toFixed(dec)}`);
        } catch(e){addAutoLog(`⚠️ SL 설정 실패: ${e.message}`);}
      }
      if(sig.takeProfit) {
        try {
          await binanceFetch("/fapi/v1/order","POST",{symbol,side:side==="BUY"?"SELL":"BUY",type:"TAKE_PROFIT_MARKET",stopPrice:sig.takeProfit.toFixed(dec),quantity:qty,positionSide:"BOTH",timeInForce:"GTE_GTC"},true);
          addAutoLog(`🎯 TP 설정: $${sig.takeProfit.toFixed(dec)}`);
        } catch(e){addAutoLog(`⚠️ TP 설정 실패: ${e.message}`);}
      }
    } catch(e) {
      addAutoLog(`❌ ${symbol} 주문 오류: ${e.message}`);
    }
    // 심볼 간 딜레이
    await new Promise(r => setTimeout(r, 1000));
  }

  autoState.running = false;
  if(autoState.enabled) {
    autoState.nextRun = new Date(Date.now() + autoState.interval * 1000).toLocaleString("ko-KR");
  }
  addAutoLog(`✔ 자동 분석 완료. 다음 실행: ${autoState.nextRun||"-"}`);
}

function startAutoTimer() {
  if(autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(runAutoTrade, autoState.interval * 1000);
  autoState.nextRun = new Date(Date.now() + autoState.interval * 1000).toLocaleString("ko-KR");
}
function stopAutoTimer() {
  if(autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  autoState.nextRun = null;
}

// ── API 라우트 ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status:"ok", service:"APEX TRADER Backend v3", time:new Date().toISOString() }));

app.get("/api/account", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v3/account","GET",{},true)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/api/positions", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v2/positionRisk","GET",{},true)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/api/open-orders", async (req, res) => {
  try {
    const params = req.query.symbol ? { symbol:req.query.symbol } : {};
    res.json(await binanceFetch("/fapi/v1/openOrders","GET",params,true));
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/api/prices", async (req, res) => {
  try {
    const data = await fetch("https://fapi.binance.com/fapi/v1/ticker/price").then(r=>r.json());
    const symbols = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","DOTUSDT","LINKUSDT","MATICUSDT","LTCUSDT","UNIUSDT","ATOMUSDT","NEARUSDT","APTUSDT","SUIUSDT","OPUSDT","ARBUSDT","INJUSDT"];
    const result = {};
    data.forEach(t => { if(symbols.includes(t.symbol)) result[t.symbol] = parseFloat(t.price); });
    res.json(result);
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/api/candles", async (req, res) => {
  try {
    const { symbol="BTCUSDT", interval="1m", limit=100 } = req.query;
    const data = await fetch(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`).then(r=>r.json());
    res.json(data.map(k=>({ time:k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],vol:+k[5] })));
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post("/api/leverage", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v1/leverage","POST",req.body,true)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});
app.post("/api/margin-type", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v1/marginType","POST",req.body,true)); }
  catch(e) { res.json({ msg:e.message }); }
});
app.post("/api/order", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v1/order","POST",{...req.body},true)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});
app.delete("/api/order", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v1/order","DELETE",req.body,true)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

// AI 분석 (앱용)
app.post("/api/ai-analyze", async (req, res) => {
  try {
    const { prompt } = req.body;
    if(!ANTHROPIC_KEY) return res.status(500).json({ error:"ANTHROPIC_API_KEY 미설정" });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({ model:"claude-sonnet-4-5", max_tokens:1024, messages:[{role:"user",content:prompt}] }),
    });
    const raw = await r.text();
    let data; try { data=JSON.parse(raw); } catch(e){ return res.status(500).json({error:"파싱 오류: "+raw.slice(0,100)}); }
    if(data.error) return res.status(500).json({ error:data.error.message||JSON.stringify(data.error) });
    const text = data.content?.map(i=>i.text||"").join("")||"";
    res.json({ result:text });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── 자동매매 제어 API ─────────────────────────────────────────────────────────
// 상태 조회
app.get("/api/auto/status", (req, res) => {
  res.json({ ...autoState, timerActive: !!autoTimer });
});

// 자동매매 ON/OFF + 설정
app.post("/api/auto/config", (req, res) => {
  const { enabled, interval, symbols, leverage, marginUsdt, minConfidence } = req.body;
  if(typeof enabled !== "undefined") autoState.enabled = enabled;
  if(interval)       autoState.interval       = parseInt(interval);
  if(symbols)        autoState.symbols        = symbols;
  if(leverage)       autoState.leverage       = parseInt(leverage);
  if(marginUsdt)     autoState.marginUsdt     = parseFloat(marginUsdt);
  if(minConfidence)  autoState.minConfidence  = parseInt(minConfidence);

  if(autoState.enabled) {
    startAutoTimer();
    runAutoTrade(); // 즉시 1회 실행
    addAutoLog(`🚀 자동매매 ON | 주기:${autoState.interval}s | 코인:${autoState.symbols.join(",")} | 레버리지:${autoState.leverage}x | 증거금:$${autoState.marginUsdt}`);
  } else {
    stopAutoTimer();
    addAutoLog("⏹ 자동매매 OFF");
  }
  res.json({ success:true, state:autoState });
});

// 즉시 1회 분석 실행
app.post("/api/auto/run-now", async (req, res) => {
  addAutoLog("▶ 수동 즉시 실행");
  runAutoTrade();
  res.json({ success:true });
});

// 포지션 청산
app.post("/api/close-position", async (req, res) => {
  try {
    const { symbol, positionAmt } = req.body;
    const side = parseFloat(positionAmt) > 0 ? "SELL" : "BUY";
    const qty  = Math.abs(parseFloat(positionAmt)).toFixed(3);
    const result = await binanceFetch("/fapi/v1/order","POST",{symbol,side,type:"MARKET",quantity:qty,reduceOnly:"true"},true);
    addAutoLog(`⬜ 청산: ${symbol} ${side} qty:${qty}`);
    res.json(result);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ APEX TRADER Backend v3 running on port ${PORT}`);
  console.log(`   API Key:    ${API_KEY    ? API_KEY.slice(0,8)+"..."    : "❌ NOT SET"}`);
  console.log(`   Secret:     ${SECRET_KEY ? "✅ SET"                    : "❌ NOT SET"}`);
  console.log(`   Anthropic:  ${ANTHROPIC_KEY ? "✅ SET"                 : "❌ NOT SET"}`);
});
