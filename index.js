const express = require("express");
const app = express();

app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: true }));

const BOT_TOKEN      = process.env.TELEGRAM_TOKEN;
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;
let CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "-1002082257259";
if (CHAT_ID === "-1001808291500") CHAT_ID = "-1002082257259";

// ── config ────────────────────────────────────────────────────────────────────
const ACCOUNT_BALANCE = 1000;
const RISK_PERCENT    = 1;
const MIN_LOT_SIZE    = 0.01;

const MIN_ATR        = 0.5;
const MAX_ATR        = 25.0;
const DEFAULT_ATR    = 5.0;
const RR_MIN         = 1.4;
const SL_MULTIPLIER  = 1.6;
const TP1_MULTIPLIER = 1.4;
const TP2_MULTIPLIER = 2.2;
const TP3_MULTIPLIER = 3.5;
const MIN_SL_DIST    = 8.0;
const MAX_SL_DIST    = 22.0;
const COOLDOWN_MS    = 10 * 60 * 1000;
const SESSION_START  = 6;
const SESSION_END    = 22;
const FRIDAY_END     = 20;

const H1_FAST_EMA        = 20;
const H1_SLOW_EMA        = 50;
const H1_CANDLES_NEEDED  = 120;

const M15_FAST_EMA       = 20;
const M15_SLOW_EMA       = 50;
const M15_CANDLES_NEEDED = 80;

const M5_FAST_EMA                        = 20;
const M5_SLOW_EMA                        = 50;
const M5_CANDLES_NEEDED                  = 60;
const M5_RECLAIM_LOOKBACK                = 5;
const M5_RECLAIM_MAX_EMA_DISTANCE_ATR    = 0.35;
const M5_MAX_ENTRY_DISTANCE_FROM_EMA_ATR = 1.2;
const M5_LAST_CANDLE_MIN_BODY_TO_ATR     = 0.18;
const M5_CHOP_OVERLAP_THRESHOLD          = 0.80;
const M5_MAX_PRESSURE_BARS               = 4;

const NEWS_WINDOW_START = 25;
const NEWS_WINDOW_END   = 35;
const WEBHOOK_DEDUP_MS  = 10_000;

// ── state ─────────────────────────────────────────────────────────────────────
const activeTrades  = new Map();
const lastSignalAt  = new Map();
const lastWebhookAt = new Map();
const tradeStats    = { total: 0, wins: 0, losses: 0, pnlPts: 0 };

const scannerState = {
  running:          false,
  isScanning:       false,
  lastScanAt:       null,
  lastM5CandleTime: null,
  lastH1Bias:       null,
  lastM15Result:    null,
  lastM5Result:     null,
};

const scannerStats = {
  totalScans:      0,
  h1Neutral:       0,
  m15Rejected:     0,
  m5Rejected:      0,
  canOpenRejected: 0,
  entriesOpened:   0,
};

// ── helpers ───────────────────────────────────────────────────────────────────
function r(x, d = 2) {
  return Math.round(Number(x) * 10 ** d) / 10 ** d;
}

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function normalizeSignal(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  if (["BUY", "LONG"].includes(s))   return "LONG";
  if (["SELL", "SHORT"].includes(s)) return "SHORT";
  return null;
}

function normalizeTicker(v) {
  if (!v) return "XAUUSD";
  const s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.includes("XAUUSD")) return "XAUUSD";
  if (s === "GOLD")         return "XAUUSD";
  return s;
}

function getWarsawNowParts() {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
    hour:    "numeric",
    minute:  "numeric",
    hour12:  false,
  }).formatToParts(now);
  return {
    weekday: parts.find(p => p.type === "weekday")?.value ?? "",
    hour:    parseInt(parts.find(p => p.type === "hour")?.value   ?? "0", 10),
    minute:  parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10),
  };
}

function isInSession() {
  const { weekday, hour } = getWarsawNowParts();
  if (["Sat", "Sun"].includes(weekday)) return false;
  if (weekday === "Fri" && hour >= FRIDAY_END) return false;
  return hour >= SESSION_START && hour < SESSION_END;
}

function isNewsTime() {
  const { minute } = getWarsawNowParts();
  return minute >= NEWS_WINDOW_START && minute <= NEWS_WINDOW_END;
}

// ── indicators ────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = candles.map((c, i, arr) => {
    const h  = parseFloat(c.high);
    const lo = parseFloat(c.low);
    if (i === 0) return h - lo;
    const pc = parseFloat(arr[i - 1].close);
    return Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── TwelveData helpers ────────────────────────────────────────────────────────
function toTwelveSymbol(ticker) {
  if (ticker === "XAUUSD") return "XAU/USD";
  if (ticker === "XAGUSD") return "XAG/USD";
  return ticker;
}

async function fetchCandles(ticker, count = 60, interval = "1min") {
  if (!TWELVEDATA_KEY) return null;
  try {
    const sym = encodeURIComponent(toTwelveSymbol(ticker));
    const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=${interval}&outputsize=${count}&apikey=${TWELVEDATA_KEY}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (!json.values || !Array.isArray(json.values)) {
      console.warn(`[CANDLES] TwelveData (${interval}): ${json.message ?? "brak danych"}`);
      return null;
    }
    return json.values.slice().reverse();
  } catch (e) {
    console.error("[CANDLES] fetch error:", e.message);
    return null;
  }
}

async function fetchPrice(ticker) {
  if (!TWELVEDATA_KEY) return null;
  try {
    const url  = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(toTwelveSymbol(ticker))}&apikey=${TWELVEDATA_KEY}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.price) return parseFloat(json.price);
    console.warn(`[MONITOR] TwelveData: ${json.message ?? "brak ceny"}`);
    return null;
  } catch (e) {
    console.error("[MONITOR] fetch error:", e.message);
    return null;
  }
}

// ── H1 bias ───────────────────────────────────────────────────────────────────
async function getH1Bias(ticker) {
  const candles = await fetchCandles(ticker, H1_CANDLES_NEEDED, "1h");
  if (!candles || candles.length < H1_SLOW_EMA + 2) {
    console.warn(`[H1] Za mało świec H1 (${candles?.length ?? 0})`);
    return { bias: "NEUTRAL", debug: { error: "insufficient_candles" } };
  }

  const closes    = candles.map(c => parseFloat(c.close));
  const price     = closes[closes.length - 1];
  const ema20     = calcEMA(closes, H1_FAST_EMA);
  const ema50     = calcEMA(closes, H1_SLOW_EMA);
  const ema20prev = calcEMA(closes.slice(0, -1), H1_FAST_EMA);

  if (!ema20 || !ema50 || !ema20prev) {
    console.warn("[H1] Nie można obliczyć EMA H1");
    return { bias: "NEUTRAL", debug: { error: "indicator_error" } };
  }

  const ema20rising  = ema20 > ema20prev;
  const ema20falling = ema20 < ema20prev;

  let bias = "NEUTRAL";
  if (price > ema20 && ema20 > ema50 && ema20rising)  bias = "LONG";
  if (price < ema20 && ema20 < ema50 && ema20falling) bias = "SHORT";

  const debug = { price: r(price), ema20: r(ema20), ema50: r(ema50), ema20prev: r(ema20prev), ema20rising, bias };
  console.log(`[H1] bias=${bias} | price=${r(price)} EMA20=${r(ema20)} EMA50=${r(ema50)} slope=${ema20rising ? "↑" : ema20falling ? "↓" : "→"}`);
  return { bias, debug };
}

// ── M15 confirmation ──────────────────────────────────────────────────────────
async function confirmM15Direction(ticker, bias) {
  const candles = await fetchCandles(ticker, M15_CANDLES_NEEDED, "15min");
  if (!candles || candles.length < M15_SLOW_EMA + 2) {
    const reason = `REJECT_M15_INSUFFICIENT_DATA (${candles?.length ?? 0} świec)`;
    console.warn(`[M15] ${reason}`);
    return { pass: false, reason, debug: {} };
  }

  const closes = candles.map(c => parseFloat(c.close));
  const price  = closes[closes.length - 1];
  const ema20  = calcEMA(closes, M15_FAST_EMA);
  const ema50  = calcEMA(closes, M15_SLOW_EMA);

  if (!ema20 || !ema50) {
    const reason = "REJECT_M15_INDICATOR_ERROR";
    console.warn(`[M15] ${reason}`);
    return { pass: false, reason, debug: {} };
  }

  const debug   = { price: r(price), ema20: r(ema20), ema50: r(ema50) };
  const rejects = [];

  if (bias === "LONG") {
    if (!(price > ema20)) rejects.push("M15_PRICE_BELOW_EMA20");
    if (!(ema20 > ema50)) rejects.push("M15_EMA20_BELOW_EMA50");
  } else {
    if (!(price < ema20)) rejects.push("M15_PRICE_ABOVE_EMA20");
    if (!(ema20 < ema50)) rejects.push("M15_EMA20_ABOVE_EMA50");
  }

  if (rejects.length > 0) {
    const reason = `REJECT_M15_CONFIRMATION_FAILED (${rejects.join(", ")})`;
    console.log(`[M15] ${reason}`);
    return { pass: false, reason, debug };
  }

  console.log(`[M15] OK | price=${r(price)} EMA20=${r(ema20)} EMA50=${r(ema50)}`);
  return { pass: true, reason: "M15_OK", debug };
}

// ── M5 setup — pullback / reclaim ─────────────────────────────────────────────
async function checkM5Setup(ticker, bias) {
  const candles = await fetchCandles(ticker, M5_CANDLES_NEEDED, "5min");
  if (!candles || candles.length < M5_SLOW_EMA + M5_RECLAIM_LOOKBACK + 2) {
    const reason = `REJECT_M5_INSUFFICIENT_DATA (${candles?.length ?? 0} świec)`;
    console.warn(`[M5] ${reason}`);
    return { pass: false, reason, atr: null, entry: null, debug: {} };
  }

  const closes = candles.map(c => parseFloat(c.close));
  const last5  = candles.slice(-5);

  const price = closes[closes.length - 1];
  const ema20 = calcEMA(closes, M5_FAST_EMA);
  const ema50 = calcEMA(closes, M5_SLOW_EMA);
  const atr   = calcATR(candles);

  if (!ema20 || !ema50 || !atr) {
    const reason = "REJECT_M5_INDICATOR_ERROR";
    console.warn(`[M5] ${reason}`);
    return { pass: false, reason, atr: null, entry: null, debug: {} };
  }

  const rejects    = [];
  const lastCandle = candles[candles.length - 1];
  const lastClose  = parseFloat(lastCandle.close);
  const lastOpen   = parseFloat(lastCandle.open);
  const lastBody   = Math.abs(lastClose - lastOpen);

  const lookbackCandles = candles.slice(-(M5_RECLAIM_LOOKBACK + 1), -1);

  // 1. EMA alignment
  if (bias === "LONG") {
    if (!(ema20 > ema50)) rejects.push("M5_EMA20_BELOW_EMA50");
  } else {
    if (!(ema20 < ema50)) rejects.push("M5_EMA20_ABOVE_EMA50");
  }

  // 2. Reclaim
  const maxReclaimDist = M5_RECLAIM_MAX_EMA_DISTANCE_ATR * atr;
  let reclaimFound = false;

  if (bias === "LONG") {
    for (const c of lookbackCandles) {
      if (Math.abs(parseFloat(c.low) - ema20) <= maxReclaimDist) { reclaimFound = true; break; }
    }
    if (!reclaimFound)
      rejects.push(`M5_NO_RECLAIM_LONG (żaden low w ostatnich ${M5_RECLAIM_LOOKBACK} świecach nie był blisko EMA20 ±${r(maxReclaimDist)} pkt)`);
  } else {
    for (const c of lookbackCandles) {
      if (Math.abs(parseFloat(c.high) - ema20) <= maxReclaimDist) { reclaimFound = true; break; }
    }
    if (!reclaimFound)
      rejects.push(`M5_NO_RECLAIM_SHORT (żaden high w ostatnich ${M5_RECLAIM_LOOKBACK} świecach nie był blisko EMA20 ±${r(maxReclaimDist)} pkt)`);
  }

  // 3. Ostatnia świeca po właściwej stronie EMA20
  if (bias === "LONG") {
    if (!(lastClose > ema20)) rejects.push(`M5_LAST_CLOSE_BELOW_EMA20 (close=${r(lastClose)} ema20=${r(ema20)})`);
    if (!(lastClose > lastOpen)) rejects.push("M5_LAST_CANDLE_NOT_BULLISH");
  } else {
    if (!(lastClose < ema20)) rejects.push(`M5_LAST_CLOSE_ABOVE_EMA20 (close=${r(lastClose)} ema20=${r(ema20)})`);
    if (!(lastClose < lastOpen)) rejects.push("M5_LAST_CANDLE_NOT_BEARISH");
  }

  // 4. Body ostatniej świecy
  if (lastBody < M5_LAST_CANDLE_MIN_BODY_TO_ATR * atr)
    rejects.push(`M5_LAST_CANDLE_WEAK_BODY (body=${r(lastBody)} < ${M5_LAST_CANDLE_MIN_BODY_TO_ATR}x ATR=${r(atr)})`);

  // 5. Dystans od EMA20
  const emaDistAtr = Math.abs(lastClose - ema20) / atr;
  if (emaDistAtr > M5_MAX_ENTRY_DISTANCE_FROM_EMA_ATR)
    rejects.push(`M5_TOO_FAR_FROM_EMA (${emaDistAtr.toFixed(2)}x ATR > max ${M5_MAX_ENTRY_DISTANCE_FROM_EMA_ATR}x ATR)`);

  // 6. Chop filter
  let choppyPairs = 0;
  for (let i = 1; i < last5.length; i++) {
    const pH = parseFloat(last5[i-1].high), pL = parseFloat(last5[i-1].low);
    const cH = parseFloat(last5[i].high),   cL = parseFloat(last5[i].low);
    const overlap = Math.max(0, Math.min(pH, cH) - Math.max(pL, cL));
    const total   = Math.max(pH, cH) - Math.min(pL, cL);
    if (total > 0 && overlap / total > M5_CHOP_OVERLAP_THRESHOLD) choppyPairs++;
  }
  if (choppyPairs >= 3)
    rejects.push(`M5_CHOP (${choppyPairs}/4 par nakłada się > ${M5_CHOP_OVERLAP_THRESHOLD * 100}%)`);

  // 7. Overextension
  let pressureBars = 0;
  for (let i = last5.length - 1; i >= 0; i--) {
    const isBull = parseFloat(last5[i].close) > parseFloat(last5[i].open);
    const isBear = parseFloat(last5[i].close) < parseFloat(last5[i].open);
    if (bias === "LONG"  && isBull) pressureBars++;
    else if (bias === "SHORT" && isBear) pressureBars++;
    else break;
  }
  if (pressureBars > M5_MAX_PRESSURE_BARS)
    rejects.push(`M5_OVEREXTENDED (${pressureBars} świec z rzędu > max ${M5_MAX_PRESSURE_BARS})`);

  const debug = {
    price: r(price), ema20: r(ema20), ema50: r(ema50), atr: r(atr),
    reclaimFound, reclaimWindowBars: M5_RECLAIM_LOOKBACK, reclaimMaxDist: r(maxReclaimDist),
    lastClose: r(lastClose), lastOpen: r(lastOpen), lastBody: r(lastBody),
    emaDistAtr: `${emaDistAtr.toFixed(2)}x`, choppyPairs, pressureBars,
  };

  if (rejects.length > 0) {
    const reason = `REJECT_M5_SETUP_FAILED (${rejects.join(" | ")})`;
    console.log(`[M5] ${reason}`);
    return { pass: false, reason, atr: r(atr), entry: null, debug };
  }

  console.log(`[M5] OK — reclaim CONFIRMED | close=${r(lastClose)} EMA20=${r(ema20)} ATR=${r(atr)} dist=${emaDistAtr.toFixed(2)}x`);
  return { pass: true, reason: "M5_OK", atr: r(atr), entry: r(lastClose), debug };
}

// ── position sizing (info only) ───────────────────────────────────────────────
function calcLotSize(entry, sl) {
  const riskAmount = ACCOUNT_BALANCE * (RISK_PERCENT / 100);
  const slDistance = Math.abs(entry - sl);
  if (slDistance === 0) return { lotSize: MIN_LOT_SIZE, riskAmount, slDistance: 0, floored: false };
  const raw     = riskAmount / (slDistance * 100);
  const lotSize = Math.max(r(raw, 2), MIN_LOT_SIZE);
  return { lotSize, riskAmount, slDistance: r(slDistance), floored: raw < MIN_LOT_SIZE };
}

// ── levels builder ────────────────────────────────────────────────────────────
function buildLevels(signal, entry, atr) {
  const rawSlD = atr * SL_MULTIPLIER;
  const slD    = Math.min(Math.max(rawSlD, MIN_SL_DIST), MAX_SL_DIST);
  const dir    = signal === "LONG" ? 1 : -1;

  const sl  = r(entry - dir * slD);
  const tp1 = r(entry + dir * slD * TP1_MULTIPLIER);
  const tp2 = r(entry + dir * slD * TP2_MULTIPLIER);
  const tp3 = r(entry + dir * slD * TP3_MULTIPLIER);

  const risk    = Math.abs(entry - sl);
  const reward1 = Math.abs(tp1 - entry);
  const reward2 = Math.abs(tp2 - entry);
  const reward3 = Math.abs(tp3 - entry);

  return {
    entry, sl, tp1, tp2, tp3,
    rr1: r(risk > 0 ? reward1 / risk : 0),
    rr2: r(risk > 0 ? reward2 / risk : 0),
    rr3: r(risk > 0 ? reward3 / risk : 0),
    slDist:  r(slD),
    tp1Dist: r(slD * TP1_MULTIPLIER),
    tp2Dist: r(slD * TP2_MULTIPLIER),
    tp3Dist: r(slD * TP3_MULTIPLIER),
  };
}

// ── gate checks ───────────────────────────────────────────────────────────────
function canOpen(ticker, signal, entry, atr) {
  if (atr < MIN_ATR) return { ok: false, reason: `ATR za niskie (${atr.toFixed(2)} < ${MIN_ATR})` };
  if (atr > MAX_ATR) return { ok: false, reason: `ATR za wysokie (${atr.toFixed(2)} > ${MAX_ATR})` };

  const active = activeTrades.get(ticker);
  if (active?.status === "OPEN")
    return { ok: false, reason: `Aktywna pozycja ${active.signal} już otwarta na ${ticker}` };

  const lastAt = lastSignalAt.get(ticker);
  if (lastAt !== undefined) {
    const elapsed = Date.now() - lastAt;
    if (elapsed < COOLDOWN_MS) {
      const rem = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
      return { ok: false, reason: `Cooldown — jeszcze ${rem} min` };
    }
  }

  if (!isInSession()) {
    const { weekday, hour, minute } = getWarsawNowParts();
    return {
      ok: false,
      reason: `Poza sesją (teraz ${weekday} ${hour}:${String(minute).padStart(2,"0")} Warszawa | ` +
               `sesja Pn–Czw 06:00–22:00, Pt 06:00–${FRIDAY_END}:00)`,
    };
  }

  if (isNewsTime()) {
    const { minute } = getWarsawNowParts();
    return { ok: false, reason: `REJECT_NEWS_TIME_WINDOW (minuta ${minute}, okno :${NEWS_WINDOW_START}–:${NEWS_WINDOW_END})` };
  }

  const levels = buildLevels(signal, entry, atr);
  const risk   = Math.abs(entry - levels.sl);
  const reward = Math.abs(levels.tp1 - entry);
  const realRR = risk > 0 ? r(reward / risk) : 0;

  if (realRR < RR_MIN)
    return { ok: false, reason: `REJECT_RR_TOO_LOW (RR=${realRR} < min ${RR_MIN}, risk=${r(risk)}, reward=${r(reward)})` };

  return { ok: true, reason: "ACCEPT", levels };
}

// ── trade management ──────────────────────────────────────────────────────────
let tradeIdCounter = 0;

function registerTrade(ticker, signal, levels) {
  tradeIdCounter++;
  activeTrades.set(ticker, {
    id:          tradeIdCounter,
    ticker,
    signal,
    entry:       levels.entry,
    sl:          levels.sl,
    slOriginal:  levels.sl,
    tp1:         levels.tp1,
    tp2:         levels.tp2,
    tp3:         levels.tp3,
    status:      "OPEN",
    openedAt:    new Date().toUTCString(),
    tp1Hit:      false,
    tp2Hit:      false,
    closedAt:    null,
    closePrice:  null,
    closeReason: null,
    pnlPts:      null,
  });
  lastSignalAt.set(ticker, Date.now());
  tradeStats.total++;
}

function closeTrade(ticker, closePrice, reason) {
  const trade = activeTrades.get(ticker);
  if (!trade) return;
  const pnl = trade.signal === "LONG"
    ? r(closePrice - trade.entry)
    : r(trade.entry - closePrice);
  trade.status      = "CLOSED";
  trade.closedAt    = new Date().toUTCString();
  trade.closePrice  = r(closePrice);
  trade.closeReason = reason;
  trade.pnlPts      = pnl;
  if (reason.startsWith("TP")) tradeStats.wins++;
  else if (reason === "SL")    tradeStats.losses++;
  tradeStats.pnlPts = r(tradeStats.pnlPts + pnl);
}

// ── telegram ──────────────────────────────────────────────────────────────────
function formatEntry(ticker, signal, levels, atr, tf, strategy) {
  const emoji = signal === "LONG" ? "🟢" : "🔴";
  const dir   = signal === "LONG" ? "LONG  📈" : "SHORT 📉";
  const { lotSize, riskAmount, slDistance, floored } = calcLotSize(levels.entry, levels.sl);
  const lotNote = floored ? " <i>(min)</i>" : "";
  return (
    `${emoji} <b>${ticker} ${dir}</b>\n\n` +
    `💰 <b>Entry:</b> <code>${levels.entry}</code>\n` +
    `🛡 <b>SL:</b>    <code>${levels.sl}</code>  <i>(-${levels.slDist} pkt)</i>\n\n` +
    `🎯 <b>TP1:</b>   <code>${levels.tp1}</code>  <i>(+${levels.tp1Dist} pkt | RR ${levels.rr1})</i>\n` +
    `🎯🎯 <b>TP2:</b>  <code>${levels.tp2}</code>  <i>(+${levels.tp2Dist} pkt | RR ${levels.rr2})</i>\n` +
    `🚀 <b>TP3:</b>   <code>${levels.tp3}</code>  <i>(+${levels.tp3Dist} pkt | RR ${levels.rr3})</i>\n\n` +
    `📊 <b>ATR14:</b> ${r(atr)}  |  <b>TF:</b> ${tf}\n\n` +
    `💼 <b>Kalkulator pozycji</b> <i>(tylko info)</i>\n` +
    `   Balans: $${ACCOUNT_BALANCE}  |  Ryzyko: ${RISK_PERCENT}% ($${r(riskAmount)})\n` +
    `   SL dystans: ${slDistance} pkt\n` +
    `   📐 <b>Lot size: <code>${lotSize}</code>${lotNote}</b>\n\n` +
    `🤖 <i>${strategy}</i>\n` +
    `🕐 <i>${new Date().toUTCString()}</i>`
  );
}

async function sendTelegram(text) {
  if (!BOT_TOKEN) { console.error("[TG] TELEGRAM_TOKEN nie ustawiony"); return { ok: false, error: "no token" }; }
  try {
    const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
    });
    const json = await res.json();
    if (!json.ok) { console.error("[TG] Telegram error:", json.description); return { ok: false, error: json.description }; }
    console.log("[TG] Wiadomość wysłana OK");
    return { ok: true };
  } catch (e) {
    console.error("[TG] fetch error:", e.message);
    return { ok: false, error: String(e) };
  }
}

// ── price monitor (TP/SL tracking) ───────────────────────────────────────────
async function checkTrades() {
  for (const [ticker, trade] of activeTrades.entries()) {
    if (trade.status !== "OPEN") continue;

    const price = await fetchPrice(ticker);
    if (price === null) continue;

    const isLong = trade.signal === "LONG";

    // TP1
    if (!trade.tp1Hit && (isLong ? price >= trade.tp1 : price <= trade.tp1)) {
      trade.tp1Hit = true;
      trade.sl     = trade.entry;
      const pnl1   = r(Math.abs(trade.tp1 - trade.entry));
      await sendTelegram(
        `🎯 <b>TP1 HIT — ${ticker} #${trade.id}</b>\n` +
        `Wejście: <code>${trade.entry}</code> → TP1: <code>${r(trade.tp1)}</code>\n` +
        `Cena: <code>${r(price)}</code>  |  +${pnl1} pkt\n\n` +
        `🔒 <b>SL → entry (breakeven): <code>${trade.entry}</code></b>\n` +
        `🎯🎯 Cel TP2: <code>${r(trade.tp2)}</code>\n` +
        `<i>${new Date().toUTCString()}</i>`
      );
    }

    // TP2
    if (!trade.tp2Hit && (isLong ? price >= trade.tp2 : price <= trade.tp2)) {
      trade.tp1Hit = true;
      trade.tp2Hit = true;
      trade.sl     = trade.tp1;
      const pnl2   = r(Math.abs(trade.tp2 - trade.entry));
      await sendTelegram(
        `🎯🎯 <b>TP2 HIT — ${ticker} #${trade.id}</b>\n` +
        `Wejście: <code>${trade.entry}</code> → TP2: <code>${r(trade.tp2)}</code>\n` +
        `Cena: <code>${r(price)}</code>  |  +${pnl2} pkt\n\n` +
        `🔒 <b>SL → TP1 (profit locked): <code>${r(trade.tp1)}</code></b>\n` +
        `🚀 Cel TP3: <code>${r(trade.tp3)}</code>\n` +
        `<i>${new Date().toUTCString()}</i>`
      );
    }

    // TP3
    if (isLong ? price >= trade.tp3 : price <= trade.tp3) {
      const pnl3 = r(Math.abs(trade.tp3 - trade.entry));
      closeTrade(ticker, price, "TP3");
      lastSignalAt.set(ticker, Date.now());
      await sendTelegram(
        `🚀 <b>TP3 HIT — PEŁNE ZAMKNIĘCIE — ${ticker} #${trade.id}</b>\n` +
        `Pozycja: ${trade.signal} @ <code>${trade.entry}</code>\n` +
        `TP3: <code>${r(trade.tp3)}</code>  |  Cena: <code>${r(price)}</code>\n` +
        `💵 <b>P&L: +${pnl3} pkt</b>\n` +
        `Otwarto: ${trade.openedAt}\nZamknięto: ${new Date().toUTCString()}`
      );
      continue;
    }

    // SL
    if (isLong ? price <= trade.sl : price >= trade.sl) {
      const slLabel            = trade.tp2Hit ? "TP1 (profit chroniony)" : trade.tp1Hit ? "entry (breakeven)" : "oryginalny SL";
      const executedClosePrice = trade.sl;
      const pnlSl              = r(trade.signal === "LONG" ? executedClosePrice - trade.entry : trade.entry - executedClosePrice);
      const pnlStr             = pnlSl >= 0 ? `+${pnlSl}` : `${pnlSl}`;
      closeTrade(ticker, executedClosePrice, "SL");
      lastSignalAt.set(ticker, Date.now());
      await sendTelegram(
        `🛑 <b>SL HIT — ${ticker} #${trade.id}</b>\n` +
        `Pozycja: ${trade.signal} @ <code>${trade.entry}</code>\n` +
        `SL (<i>${slLabel}</i>): <code>${r(executedClosePrice)}</code>\n` +
        `Cena rynkowa w chwili wykrycia: <code>${r(price)}</code>\n` +
        `💵 <b>P&L: ${pnlStr} pkt</b>\n` +
        `Otwarto: ${trade.openedAt}\nZamknięto: ${new Date().toUTCString()}`
      );
    }
  }
}

function startPriceMonitor() {
  if (!TWELVEDATA_KEY) { console.warn("[MONITOR] TWELVEDATA_API_KEY nie ustawiony — wyłączony"); return; }
  console.log("[MONITOR] Price monitor uruchomiony (2min open trade / 10min idle)");
  let lastIdleCheck = 0;
  setInterval(async () => {
    const hasOpen = [...activeTrades.values()].some(t => t.status === "OPEN");
    const now = Date.now();
    if (hasOpen) {
      await checkTrades().catch(console.error);
    } else if (now - lastIdleCheck > 10 * 60 * 1000) {
      lastIdleCheck = now;
      await checkTrades().catch(console.error);
    }
  }, 2 * 60_000);
}

// ── autonomous scan ───────────────────────────────────────────────────────────
async function scanXAUUSD() {
  const ticker = "XAUUSD";

  const active = activeTrades.get(ticker);
  if (active?.status === "OPEN") {
    console.log(`[SCAN] Aktywny trade #${active.id} ${active.signal} @ ${active.entry} — pomijam scan`);
    return;
  }

  scannerStats.totalScans++;

  const h1 = await getH1Bias(ticker);
  scannerState.lastH1Bias = h1.bias;
  if (h1.bias === "NEUTRAL") {
    scannerStats.h1Neutral++;
    console.log(`[SCAN] REJECT — H1 NEUTRAL (brak jasnego trendu)`);
    return;
  }
  const signal = h1.bias;

  const m15 = await confirmM15Direction(ticker, signal);
  scannerState.lastM15Result = m15.reason;
  if (!m15.pass) {
    scannerStats.m15Rejected++;
    console.log(`[SCAN] REJECT — M15: ${m15.reason}`);
    return;
  }

  const m5 = await checkM5Setup(ticker, signal);
  scannerState.lastM5Result = m5.reason;
  if (!m5.pass) {
    scannerStats.m5Rejected++;
    console.log(`[SCAN] REJECT — M5: ${m5.reason}`);
    return;
  }

  const entry = m5.entry;
  const atr   = m5.atr;

  if (!Number.isFinite(entry) || !Number.isFinite(atr)) {
    console.log(`[SCAN] REJECT — brak entry lub ATR po M5 OK`);
    return;
  }

  const decision = canOpen(ticker, signal, entry, atr);
  if (!decision.ok) {
    scannerStats.canOpenRejected++;
    console.log(`[SCAN] REJECT — canOpen: ${decision.reason}`);
    return;
  }

  const levels = decision.levels;
  registerTrade(ticker, signal, levels);
  scannerStats.entriesOpened++;
  await sendTelegram(formatEntry(ticker, signal, levels, atr, "M5", "AUTONOMOUS_SCAN"));
  console.log(`[ENTRY] #${activeTrades.get(ticker).id} ${signal} ${ticker} @ ${entry} ATR=${r(atr)} H1=${h1.bias} [AUTONOMOUS]`);
}

// ── signal scanner (co zamknięcie świecy M5) ──────────────────────────────────
function startSignalScanner() {
  if (!TWELVEDATA_KEY) {
    console.warn("[SCAN] TWELVEDATA_API_KEY nie ustawiony — scanner wyłączony");
    return;
  }

  scannerState.running = true;
  console.log("[SCAN] Autonomiczny scanner uruchomiony (interwał 60s, trigger: nowa świeca M5)");

  setInterval(async () => {
    scannerState.lastScanAt = new Date().toISOString();

    if (scannerState.isScanning) {
      console.log("[SCAN] previous scan still running — skip");
      return;
    }

    const activeNow = activeTrades.get("XAUUSD");
    if (activeNow?.status === "OPEN") {
      console.log(`[SCAN] Trade #${activeNow.id} otwarty — pomijam polling świec (oszczędzam API)`);
      return;
    }

    try {
      const candles = await fetchCandles("XAUUSD", 3, "5min");
      if (!candles || candles.length < 2) {
        console.log("[SCAN] Brak danych świec M5 — pomijam");
        return;
      }

      const lastClosed = candles[candles.length - 2];
      const candleTime = lastClosed.datetime;

      if (candleTime === scannerState.lastM5CandleTime) {
        console.log(`[SCAN] no new M5 candle (last: ${candleTime})`);
        return;
      }

      scannerState.lastM5CandleTime = candleTime;
      console.log(`[SCAN] new M5 candle detected — ${candleTime} — uruchamiam scan`);

      scannerState.isScanning = true;
      try {
        await scanXAUUSD();
      } finally {
        scannerState.isScanning = false;
      }

    } catch (err) {
      console.error("[SCAN] błąd:", err.message);
      scannerState.isScanning = false;
    }
  }, 60_000);
}

// ── payload parsing ───────────────────────────────────────────────────────────
function tryParseJson(v) { try { return JSON.parse(v); } catch { return {}; } }

function parseWebhookPayload(body) {
  const raw      = typeof body === "string" ? tryParseJson(body) : body ?? {};
  const signal   = normalizeSignal(raw.signal ?? raw.side ?? raw.action ?? raw.order_action ?? raw.direction);
  const ticker   = normalizeTicker(raw.ticker ?? raw.symbol ?? raw.instrument ?? raw.market ?? "XAUUSD");
  const entry    = n(raw.entry ?? raw.price ?? raw.close ?? raw.last ?? raw.trigger_price, null);
  const atr      = n(raw.atr ?? raw.atr14 ?? raw.atr_14, DEFAULT_ATR);
  const tf       = String(raw.tf ?? raw.timeframe ?? raw.interval ?? "M1");
  const strategy = String(raw.strategy ?? raw.system ?? "TV_WEBHOOK");
  return { raw, ticker, signal, entry, atr, tf, strategy };
}

// ── routes ────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("🤖 Gold Signal Bot running ✅"));

app.get("/health", (_req, res) => res.status(200).json({
  ok:           true,
  status:       "ok",
  uptimeSec:    Math.floor(process.uptime()),
  activeTrades: [...activeTrades.values()].filter(t => t.status === "OPEN").length,
  time:         new Date().toISOString(),
  inSession:    isInSession(),
  newsTime:     isNewsTime(),
}));

app.get("/status", (_req, res) => {
  const trades = [];
  for (const [ticker, trade] of activeTrades.entries()) {
    trades.push({
      id: trade.id, ticker, signal: trade.signal, status: trade.status,
      entry: trade.entry, sl: trade.sl, slOriginal: trade.slOriginal,
      tp1: trade.tp1, tp2: trade.tp2, tp3: trade.tp3,
      tp1Hit: trade.tp1Hit, tp2Hit: trade.tp2Hit,
      openedAt: trade.openedAt, closedAt: trade.closedAt ?? null,
      closePrice: trade.closePrice ?? null, closeReason: trade.closeReason ?? null,
      pnlPts: trade.pnlPts ?? null,
    });
  }
  const cooldowns = [];
  for (const [ticker, ts] of lastSignalAt.entries()) {
    const remaining = Math.max(0, Math.ceil((COOLDOWN_MS - (Date.now() - ts)) / 60000));
    cooldowns.push({ ticker, cooldownMinRemaining: remaining });
  }
  res.json({
    botStatus:           "running",
    time:                new Date().toUTCString(),
    inSession:           isInSession(),
    newsTime:            isNewsTime(),
    qualityFilterActive: !!TWELVEDATA_KEY,
    stats:               tradeStats,
    openTrades:          trades.filter(t => t.status === "OPEN"),
    recentTrades:        trades.filter(t => t.status === "CLOSED").slice(-10),
    cooldowns,
    scanner: {
      running:          scannerState.running,
      isScanning:       scannerState.isScanning,
      lastScanAt:       scannerState.lastScanAt,
      lastM5CandleTime: scannerState.lastM5CandleTime,
      lastH1Bias:       scannerState.lastH1Bias,
      lastM15Result:    scannerState.lastM15Result,
      lastM5Result:     scannerState.lastM5Result,
    },
    scannerStats,
    config: {
      accountBalance: ACCOUNT_BALANCE,
      riskPercent:    RISK_PERCENT,
      slMultiplier:   SL_MULTIPLIER,
      rrMin:          RR_MIN,
      cooldownMin:    COOLDOWN_MS / 60000,
      session:        `Pn–Czw ${SESSION_START}:00–${SESSION_END}:00, Pt ${SESSION_START}:00–${FRIDAY_END}:00 (Warszawa)`,
    },
  });
});

app.get("/test-signal", async (_req, res) => {
  try {
    const m5     = await checkM5Setup("XAUUSD", "LONG");
    const atr    = m5.atr ?? DEFAULT_ATR;
    const entry  = m5.entry ?? (await fetchPrice("XAUUSD")) ?? 3300;
    const levels = buildLevels("LONG", entry, atr);
    const tgResult = await sendTelegram(
      `🧪 <b>TEST SYGNAŁU — XAUUSD LONG</b>\n\n` +
      formatEntry("XAUUSD", "LONG", levels, atr, "M5", "TEST") +
      `\n\n<i>⚠️ To jest sygnał testowy, nie wchodzić w pozycję!</i>`
    );
    res.json({ ok: true, telegram: tgResult, entry, atr, levels, m5debug: m5.debug, note: "Test signal sent. H1/M15 filters bypassed." });
  } catch (err) { res.json({ ok: false, error: String(err) }); }
});

app.get("/admin/close", async (req, res) => {
  const ticker = String(req.query.ticker ?? "XAUUSD").toUpperCase();
  const reason = String(req.query.reason ?? "MANUAL");
  const trade  = activeTrades.get(ticker);
  if (!trade || trade.status !== "OPEN")
    return res.json({ ok: false, reason: `Brak otwartego trade dla ${ticker}` });
  const price  = await fetchPrice(ticker) ?? trade.entry;
  closeTrade(ticker, price, reason);
  lastSignalAt.set(ticker, Date.now());
  const pnl    = trade.pnlPts;
  const pnlStr = pnl >= 0 ? `+${pnl}` : `${pnl}`;
  await sendTelegram(
    `🔧 <b>RĘCZNE ZAMKNIĘCIE — ${ticker} #${trade.id}</b>\n` +
    `Pozycja: ${trade.signal} @ <code>${trade.entry}</code>\n` +
    `Zamknięto @ <code>${r(price)}</code>  (<i>${reason}</i>)\n` +
    `💵 <b>P&L: <code>${pnlStr} pkt</code></b>\n` +
    `<i>${new Date().toUTCString()}</i>`
  );
  console.log(`[ADMIN] Ręcznie zamknięto ${ticker} @ ${r(price)} (${reason}), P&L: ${pnlStr} pkt`);
  return res.json({ ok: true, ticker, closePrice: r(price), pnlPts: pnl, reason });
});

app.get("/admin/reset-cooldown", (req, res) => {
  const ticker = String(req.query.ticker ?? "XAUUSD").toUpperCase();
  if (lastSignalAt.has(ticker)) {
    lastSignalAt.delete(ticker);
    console.log(`[ADMIN] Cooldown zresetowany dla ${ticker}`);
    return res.json({ ok: true, message: `Cooldown zresetowany dla ${ticker}` });
  }
  return res.json({ ok: false, message: `Brak cooldownu dla ${ticker}` });
});

// ── webhook — tryb pasywny (bot działa autonomicznie) ─────────────────────────
app.head("/webhook", (_req, res) => res.sendStatus(200));
app.get("/webhook",  (_req, res) => res.send("Webhook alive ✅ (bot działa w trybie autonomicznym)"));

app.post("/webhook", (req, res) => {
  const parsed = parseWebhookPayload(req.body);
  console.log("[WEBHOOK] payload otrzymany (tryb autonomiczny — ignoruję jako trigger)");
  console.log("[WEBHOOK] body:", typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  console.log("[WEBHOOK] parsed:", JSON.stringify({ ticker: parsed.ticker, signal: parsed.signal, strategy: parsed.strategy }));
  return res.status(200).json({
    ok:       true,
    accepted: false,
    reason:   "Bot works in autonomous scan mode now. Webhook payloads are logged but do not trigger trades.",
  });
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Gold Bot nasłuchuje na porcie ${PORT}`);
  startPriceMonitor();
  startSignalScanner();
});
