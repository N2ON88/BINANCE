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

// ── AI 분석 함수 (Institutional SMC/ICT + ML Score) ──────────────────────────
async function analyzeSymbol(symbol) {
  try {
    // ── 멀티 타임프레임 캔들 수집 ─────────────────────────────────────────────
    const [klines15m, klines1h, klines4h] = await Promise.all([
      fetch(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`).then(r=>r.json()),
      fetch(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=50`).then(r=>r.json()),
      fetch(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=30`).then(r=>r.json()),
    ]);

    const parse = k => ({ o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5] });
    const c15 = klines15m.map(parse);
    const c1h  = klines1h.map(parse);
    const c4h  = klines4h.map(parse);

    const cl   = c15.map(c=>c.c);
    const hi   = c15.map(c=>c.h);
    const lo   = c15.map(c=>c.l);
    const vols = c15.map(c=>c.v);
    const cur  = cl[cl.length-1];

    // ── 기본 지표 계산 ────────────────────────────────────────────────────────
    const ema = (data, n) => {
      const k = 2/(n+1); let e = data[0];
      data.forEach((v,i) => { if(i>0) e = v*k + e*(1-k); });
      return e;
    };
    const sma = (data, n) => data.slice(-n).reduce((a,b)=>a+b,0)/n;

    const ema20  = ema(cl, 20);
    const ema50  = ema(cl, 50);
    const ema200 = ema(cl, 200);
    const ema20_1h = ema(c1h.map(c=>c.c), 50);
    const ema50_4h = ema(c4h.map(c=>c.c), 50);

    // RSI
    let g=0,l=0;
    for(let i=cl.length-14;i<cl.length;i++){const d=cl[i]-cl[i-1];d>0?(g+=d):(l-=d);}
    const rsi = 100-100/(1+g/(l||1e-9));

    // ATR
    const trs = hi.slice(-14).map((h,i)=>{
      const idx=hi.length-14+i;
      return Math.max(h-lo[idx],Math.abs(h-(cl[idx-1]||cl[idx])),Math.abs(lo[idx]-(cl[idx-1]||cl[idx])));
    });
    const atr = trs.reduce((a,b)=>a+b,0)/trs.length;

    // MACD
    const ema12 = ema(cl, 12);
    const ema26 = ema(cl, 26);
    const macd  = ema12 - ema26;

    // Volume
    const volMA = sma(vols, 20);
    const highVolume = vols[vols.length-1] > volMA * 1.5;
    const vSpk = vols[vols.length-1] / volMA;

    // Bollinger Bands
    const bbMid = sma(cl, 20);
    const bbStd = Math.sqrt(cl.slice(-20).reduce((s,v)=>(s+(v-bbMid)**2),0)/20);
    const bbUpper = bbMid + 2*bbStd;
    const bbLower = bbMid - 2*bbStd;
    const bbPos = cur > bbUpper ? 'UPPER' : cur < bbLower ? 'LOWER' : 'MIDDLE';

    // ── 시장 구조 (SMC/ICT) ───────────────────────────────────────────────────
    const n = cl.length;

    // Swing High/Low (10봉)
    const swingHigh = Math.max(...hi.slice(-11,-1));
    const swingLow  = Math.min(...lo.slice(-11,-1));

    // BOS (Break of Structure)
    const bosBull = cur > swingHigh;
    const bosBear = cur < swingLow;

    // CHOCH (Change of Character)
    const chochBull = cur > hi[n-6] && lo[n-1] > lo[n-6];
    const chochBear = cur < lo[n-6] && hi[n-1] < hi[n-6];

    // Liquidity Sweep
    const highest20 = Math.max(...hi.slice(-21,-1));
    const lowest20  = Math.min(...lo.slice(-21,-1));
    const buySideLiq  = hi[n-1] > highest20 && cur < hi[n-1];  // 고점 위로 스윕 후 되돌림
    const sellSideLiq = lo[n-1] < lowest20  && cur > lo[n-1];  // 저점 아래 스윕 후 되돌림

    // Fair Value Gap (FVG)
    const bullFVG = lo[n-1] > hi[n-3];  // 현재 저점 > 2봉전 고점
    const bearFVG = hi[n-1] < lo[n-3];  // 현재 고점 < 2봉전 저점
    const bullFVGTop    = lo[n-1];
    const bullFVGBottom = hi[n-3];
    const bearFVGTop    = lo[n-3];
    const bearFVGBottom = hi[n-1];

    // Order Block
    const bullOB = cl[n-2] < c15[n-2].o && cur > hi[n-2];  // 이전 베어 캔들 돌파
    const bearOB = cl[n-2] > c15[n-2].o && cur < lo[n-2];  // 이전 불 캔들 돌파
    const bullOBLevel = lo[n-2];
    const bearOBLevel = hi[n-2];

    // ── 멀티 타임프레임 트렌드 ───────────────────────────────────────────────
    const mtfBull_1h = c1h[c1h.length-1].c > ema20_1h;
    const mtfBull_4h = c4h[c4h.length-1].c > ema50_4h;
    const mtfBear_1h = c1h[c1h.length-1].c < ema20_1h;
    const mtfBear_4h = c4h[c4h.length-1].c < ema50_4h;

    // EMA Trend
    const bullTrend = ema20 > ema50 && ema50 > ema200;
    const bearTrend = ema20 < ema50 && ema50 < ema200;

    // ── ML 스타일 점수 시스템 ─────────────────────────────────────────────────
    let bullScore = 0, bearScore = 0;

    // Trend (20점)
    bullScore += bullTrend ? 20 : 0;
    bearScore += bearTrend ? 20 : 0;

    // BOS (20점) — 가장 강한 구조 신호
    bullScore += bosBull ? 20 : 0;
    bearScore += bosBear ? 20 : 0;

    // CHOCH (10점)
    bullScore += chochBull ? 10 : 0;
    bearScore += chochBear ? 10 : 0;

    // FVG (15점)
    bullScore += bullFVG ? 15 : 0;
    bearScore += bearFVG ? 15 : 0;

    // Order Block (15점)
    bullScore += bullOB ? 15 : 0;
    bearScore += bearOB ? 15 : 0;

    // Liquidity Sweep (10점) — 반대방향 스윕 = 진입 신호
    bullScore += sellSideLiq ? 10 : 0;  // 저점 스윕 후 반등 = 롱
    bearScore += buySideLiq  ? 10 : 0;  // 고점 스윕 후 하락 = 숏

    // Volume (10점)
    bullScore += highVolume ? 10 : 0;
    bearScore += highVolume ? 10 : 0;

    // RSI (10점)
    bullScore += rsi > 55 ? 10 : (rsi < 30 ? 8 : 0);  // 과매도 반등도 가점
    bearScore += rsi < 45 ? 10 : (rsi > 70 ? 8 : 0);

    // MTF 1h (15점)
    bullScore += mtfBull_1h ? 15 : 0;
    bearScore += mtfBear_1h ? 15 : 0;

    // MTF 4h (10점)
    bullScore += mtfBull_4h ? 10 : 0;
    bearScore += mtfBear_4h ? 10 : 0;

    // MACD (5점)
    bullScore += macd > 0 ? 5 : 0;
    bearScore += macd < 0 ? 5 : 0;

    // BB Position (5점)
    bullScore += bbPos === 'LOWER' ? 5 : 0;
    bearScore += bbPos === 'UPPER' ? 5 : 0;

    // ── 포지션 확인 ───────────────────────────────────────────────────────────
    const positions = await binanceFetch("/fapi/v2/positionRisk","GET",{},true);
    const activePos = positions.find(p=>p.symbol===symbol&&parseFloat(p.positionAmt)!==0);

    // 계좌 잔고 조회
    const acct = await binanceFetch("/fapi/v3/account","GET",{},true);
    const equity = parseFloat(acct.totalWalletBalance||0);

    // ── 포지션 사이징 (자본 1% 리스크) ──────────────────────────────────────
    const riskPct = 0.01; // 자본의 1%
    const capitalRisk = equity * riskPct;
    const atrSL = atr * 1.5;
    const longSL  = cur - atrSL;
    const longTP  = cur + atrSL * autoState.leverage * 0.5; // RR ~3
    const shortSL = cur + atrSL;
    const shortTP = cur - atrSL * autoState.leverage * 0.5;

    // ── 최종 신호 결정 ────────────────────────────────────────────────────────
    const minScore = 70;
    let signal = 'HOLD';
    let confidence = 0;
    let stopLoss = null, takeProfit = null;

    if (bullScore >= minScore && bullTrend && mtfBull_1h && !activePos) {
      signal = 'LONG';
      confidence = Math.min(99, Math.round(bullScore));
      stopLoss  = longSL;
      takeProfit = longTP;
    } else if (bearScore >= minScore && bearTrend && mtfBear_1h && !activePos) {
      signal = 'SHORT';
      confidence = Math.min(99, Math.round(bearScore));
      stopLoss  = shortSL;
      takeProfit = shortTP;
    } else {
      confidence = Math.round(Math.max(bullScore, bearScore) * 0.8);
    }

    // ── 상세 리즈닝 생성 ─────────────────────────────────────────────────────
    const activeStructure = [];
    if (bosBull || bosBear) activeStructure.push(bosBull?'BOS상승돌파':'BOS하락돌파');
    if (chochBull || chochBear) activeStructure.push(chochBull?'CHOCH상승전환':'CHOCH하락전환');
    if (bullFVG || bearFVG) activeStructure.push(bullFVG?'상승FVG':'하락FVG');
    if (bullOB || bearOB) activeStructure.push(bullOB?'상승OB':'하락OB');
    if (sellSideLiq || buySideLiq) activeStructure.push(sellSideLiq?'저점유동성스윕':'고점유동성스윕');

    const reasoning = `불점수:${bullScore}/베어점수:${bearScore} | MTF(1h:${mtfBull_1h?'▲':'▼'},4h:${mtfBull_4h?'▲':'▼'}) | RSI:${rsi.toFixed(1)} BB:${bbPos} | 활성구조:[${activeStructure.join(',')||'없음'}]`;

    return {
      signal,
      confidence,
      entry: cur,
      stopLoss,
      takeProfit,
      reasoning,
      trend: bullTrend?'BULLISH':bearTrend?'BEARISH':'NEUTRAL',
      riskLevel: atrSL/cur > 0.02 ? 'HIGH' : atrSL/cur > 0.01 ? 'MEDIUM' : 'LOW',
      // 상세 데이터
      bullScore, bearScore,
      indicators: { ema20, ema50, ema200, rsi, atr, macd, bbPos, vSpk: vSpk.toFixed(2) },
      structure: { bosBull, bosBear, chochBull, chochBear, bullFVG, bearFVG, bullOB, bearOB, sellSideLiq, buySideLiq },
      mtf: { bull1h: mtfBull_1h, bull4h: mtfBull_4h },
      symbol,
      currentPrice: cur,
      activePos,
    };

  } catch(e) {
    addAutoLog(`❌ ${symbol} 분석 오류: ${e.message}`);
    return null;
  }
}

// ── 자동매매 실행 (Institutional SMC/ICT) ────────────────────────────────────
async function runAutoTrade() {
  if (autoState.running) return;
  autoState.running = true;
  autoState.lastRun = new Date().toLocaleString("ko-KR");
  addAutoLog(`🔄 자동 분석 시작 (${autoState.symbols.join(", ")})`);

  for (const symbol of autoState.symbols) {
    try {
      const sig = await analyzeSymbol(symbol);
      if (!sig) continue;

      // 상세 로그 출력
      const s = sig.structure || {};
      const structStr = [
        s.bosBull?'BOS↑':s.bosBear?'BOS↓':'',
        s.chochBull?'CHOCH↑':s.chochBear?'CHOCH↓':'',
        s.bullFVG?'FVG↑':s.bearFVG?'FVG↓':'',
        s.bullOB?'OB↑':s.bearOB?'OB↓':'',
        s.sellSideLiq?'LiqSweep↑':s.buySideLiq?'LiqSweep↓':'',
      ].filter(Boolean).join(' ');

      addAutoLog(`🤖 ${symbol}: ${sig.signal} 불:${sig.bullScore||0}/베어:${sig.bearScore||0} | MTF(1h:${sig.mtf?.bull1h?'▲':'▼'} 4h:${sig.mtf?.bull4h?'▲':'▼'}) | RSI:${sig.indicators?.rsi?.toFixed(1)||'?'} | 구조:[${structStr||'없음'}]`);

      // 진입 조건 체크
      if (sig.signal === "HOLD" || sig.confidence < autoState.minConfidence) {
        addAutoLog(`⏭ ${symbol}: HOLD (불:${sig.bullScore||0}점 / 베어:${sig.bearScore||0}점 / 최소:${autoState.minConfidence}점)`);
        continue;
      }
      if (sig.activePos) {
        addAutoLog(`⏭ ${symbol}: 이미 포지션 있음 (${parseFloat(sig.activePos.positionAmt)>0?'LONG':'SHORT'})`);
        continue;
      }

      // 거래 시간 필터 (변동성 낮은 새벽 시간 제외 - UTC 기준)
      const hour = new Date().getUTCHours();
      const isLowVolTime = hour >= 2 && hour <= 6; // UTC 2~6시 = 한국 새벽 11시~오후3시 제외
      if (isLowVolTime && sig.indicators?.vSpk < 1.2) {
        addAutoLog(`⏭ ${symbol}: 저거래량 시간대 스킵 (거래량 스파이크: ${sig.indicators?.vSpk}x)`);
        continue;
      }

      // 주문 실행
      const side = sig.signal === "LONG" ? "BUY" : "SELL";
      const dec = symbol.includes("BTC")?1:symbol.includes("ETH")?2:3;
      const price = sig.currentPrice;

      await binanceFetch("/fapi/v1/leverage","POST",{symbol,leverage:autoState.leverage},true);
      try { await binanceFetch("/fapi/v1/marginType","POST",{symbol,marginType:"ISOLATED"},true); } catch(e){}

      const qty = (autoState.marginUsdt / price * autoState.leverage).toFixed(3);
      const order = await binanceFetch("/fapi/v1/order","POST",{symbol,side,type:"MARKET",quantity:qty,positionSide:"BOTH"},true);
      if(order.code&&order.code<0) throw new Error(order.msg);

      addAutoLog(`✅ ${sig.signal} ${symbol} x${autoState.leverage} qty:${qty} @ $${price.toFixed(dec)} | 불:${sig.bullScore||0}/베어:${sig.bearScore||0}`);

      // SL 설정
      if(sig.stopLoss) {
        try {
          await binanceFetch("/fapi/v1/order","POST",{
            symbol, side:side==="BUY"?"SELL":"BUY",
            type:"STOP_MARKET",
            stopPrice:sig.stopLoss.toFixed(dec),
            quantity:qty, positionSide:"BOTH", timeInForce:"GTE_GTC"
          },true);
          const slPct = Math.abs((sig.stopLoss-price)/price*100).toFixed(2);
          addAutoLog(`🛡 SL: $${sig.stopLoss.toFixed(dec)} (-${slPct}%)`);
        } catch(e){addAutoLog(`⚠️ SL 설정 실패: ${e.message}`);}
      }

      // TP 설정
      if(sig.takeProfit) {
        try {
          await binanceFetch("/fapi/v1/order","POST",{
            symbol, side:side==="BUY"?"SELL":"BUY",
            type:"TAKE_PROFIT_MARKET",
            stopPrice:sig.takeProfit.toFixed(dec),
            quantity:qty, positionSide:"BOTH", timeInForce:"GTE_GTC"
          },true);
          const tpPct = Math.abs((sig.takeProfit-price)/price*100).toFixed(2);
          addAutoLog(`🎯 TP: $${sig.takeProfit.toFixed(dec)} (+${tpPct}%)`);
        } catch(e){addAutoLog(`⚠️ TP 설정 실패: ${e.message}`);}
      }

    } catch(e) {
      addAutoLog(`❌ ${symbol} 주문 오류: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  autoState.running = false;
  if(autoState.enabled) {
    autoState.nextRun = new Date(Date.now() + autoState.interval * 1000).toLocaleString("ko-KR");
  }
  addAutoLog(`✔ 분석 완료. 다음: ${autoState.nextRun||"-"}`);
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
    const { symbol="BTCUSDT", interval="1m", limit=100, endTime } = req.query;
    let url = `${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if(endTime) url += `&endTime=${endTime}`;
    const data = await fetch(url).then(r=>r.json());
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
