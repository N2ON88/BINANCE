// v2
const express = require("express");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors());
app.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const BINANCE_BASE = "https://fapi.binance.com";
const API_KEY    = process.env.BINANCE_API_KEY    || "";
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

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
    headers: {
      "X-MBX-APIKEY": API_KEY,
      ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method !== "GET" ? { body: qs } : {}),
  });
  return res.json();
}

// 헬스체크
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "APEX TRADER Backend", time: new Date().toISOString() });
});

// 계좌
app.get("/api/account", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v3/account", "GET", {}, true)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 포지션
app.get("/api/positions", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v2/positionRisk", "GET", {}, true)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 미체결 주문
app.get("/api/open-orders", async (req, res) => {
  try {
    const params = req.query.symbol ? { symbol: req.query.symbol } : {};
    res.json(await binanceFetch("/fapi/v1/openOrders", "GET", params, true));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 가격 조회 (실시간)
app.get("/api/prices", async (req, res) => {
  try {
    const data = await fetch("https://fapi.binance.com/fapi/v1/ticker/price").then(r => r.json());
    const symbols = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];
    const result = {};
    data.forEach(t => { if (symbols.includes(t.symbol)) result[t.symbol] = parseFloat(t.price); });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 캔들 조회
app.get("/api/candles", async (req, res) => {
  try {
    const { symbol = "BTCUSDT", interval = "1m", limit = 100 } = req.query;
    const data = await fetch(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`).then(r => r.json());
    res.json(data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 레버리지
app.post("/api/leverage", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v1/leverage", "POST", req.body, true)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 마진타입
app.post("/api/margin-type", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v1/marginType", "POST", req.body, true)); }
  catch (e) { res.json({ msg: e.message }); }
});

// 주문
app.post("/api/order", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v1/order", "POST", { ...req.body }, true)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 주문취소
app.delete("/api/order", async (req, res) => {
  try { res.json(await binanceFetch("/fapi/v1/order", "DELETE", req.body, true)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// AI 분석 (Anthropic API - 서버에서 호출)
app.post("/api/ai-analyze", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다" });
    }
    console.log("[AI] 분석 요청 시작...");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const raw = await r.text();
    console.log("[AI] 응답 상태:", r.status, "길이:", raw.length);
    let data;
    try { data = JSON.parse(raw); }
    catch(e) { return res.status(500).json({ error: "Anthropic 응답 파싱 실패: " + raw.slice(0,200) }); }
    if (data.error) return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });
    const text = data.content?.map(i => i.text || "").join("") || "";
    console.log("[AI] 결과 길이:", text.length);
    res.json({ result: text });
  } catch (e) {
    console.error("[AI] 오류:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ APEX TRADER Backend running on port ${PORT}`);
  console.log(`   API Key:     ${API_KEY    ? API_KEY.slice(0,8)+"..."    : "❌ NOT SET"}`);
  console.log(`   Secret:      ${SECRET_KEY ? "✅ SET"                    : "❌ NOT SET"}`);
  console.log(`   Anthropic:   ${ANTHROPIC_KEY ? "✅ SET"                 : "⚠️  NOT SET (AI 분석 불가)"}`);
});
