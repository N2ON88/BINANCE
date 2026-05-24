const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors()); // 모든 origin 허용 (본인만 URL 알면 OK)

const BINANCE_BASE = "https://fapi.binance.com";

// ── 환경변수에서 API 키 읽기 ──────────────────────────────────────────────
// Railway 대시보드에서 BINANCE_API_KEY, BINANCE_SECRET_KEY 설정
const API_KEY    = process.env.BINANCE_API_KEY    || "";
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || "";

// ── 서명 함수 ─────────────────────────────────────────────────────────────
function sign(params) {
  const qs = new URLSearchParams(params).toString();
  return crypto.createHmac("sha256", SECRET_KEY).update(qs).digest("hex");
}

// ── Binance 요청 헬퍼 ─────────────────────────────────────────────────────
async function binanceFetch(path, method = "GET", params = {}, signed = false) {
  if (signed) {
    params.timestamp  = Date.now();
    params.recvWindow = 5000;
    params.signature  = sign(params);
  }

  const qs  = new URLSearchParams(params).toString();
  const url = method === "GET"
    ? `${BINANCE_BASE}${path}?${qs}`
    : `${BINANCE_BASE}${path}`;

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

// ── 헬스체크 ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "APEX TRADER Backend", time: new Date().toISOString() });
});

// ── 연결 테스트 (계좌 잔고 확인) ─────────────────────────────────────────
app.get("/api/account", async (req, res) => {
  try {
    const data = await binanceFetch("/fapi/v3/account", "GET", {}, true);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 포지션 조회 ───────────────────────────────────────────────────────────
app.get("/api/positions", async (req, res) => {
  try {
    const data = await binanceFetch("/fapi/v2/positionRisk", "GET", {}, true);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 미체결 주문 조회 ──────────────────────────────────────────────────────
app.get("/api/open-orders", async (req, res) => {
  try {
    const params = req.query.symbol ? { symbol: req.query.symbol } : {};
    const data = await binanceFetch("/fapi/v1/openOrders", "GET", params, true);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 레버리지 설정 ─────────────────────────────────────────────────────────
app.post("/api/leverage", async (req, res) => {
  try {
    const { symbol, leverage } = req.body;
    const data = await binanceFetch("/fapi/v1/leverage", "POST", { symbol, leverage }, true);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 마진 타입 설정 ────────────────────────────────────────────────────────
app.post("/api/margin-type", async (req, res) => {
  try {
    const { symbol, marginType } = req.body;
    const data = await binanceFetch("/fapi/v1/marginType", "POST", { symbol, marginType }, true);
    res.json(data);
  } catch (e) {
    // "No need to change margin type." 은 정상
    res.json({ msg: e.message });
  }
});

// ── 주문 실행 ─────────────────────────────────────────────────────────────
app.post("/api/order", async (req, res) => {
  try {
    const params = { ...req.body };
    const data = await binanceFetch("/fapi/v1/order", "POST", params, true);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 주문 취소 ─────────────────────────────────────────────────────────────
app.delete("/api/order", async (req, res) => {
  try {
    const { symbol, orderId } = req.body;
    const data = await binanceFetch("/fapi/v1/order", "DELETE", { symbol, orderId }, true);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 서버 시작 ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ APEX TRADER Backend running on port ${PORT}`);
  console.log(`   API Key: ${API_KEY ? API_KEY.slice(0, 8) + "..." : "❌ NOT SET"}`);
  console.log(`   Secret:  ${SECRET_KEY ? "✅ SET" : "❌ NOT SET"}`);
});
