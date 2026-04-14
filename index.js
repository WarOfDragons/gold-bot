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
const RR_MIN         = 1.8;
const SL_MULTIPLIER  = 1.1;
const TP1_MULTIPLIER = 2.0;
const TP2_MULTIPLIER = 3.2;
const TP3_MULTIPLIER = 6.0;
const MIN_SL_DIST    = 5.0;
const MAX_SL_DIST    = 18.0;
const COOLDOWN_MS    = 10 * 60 * 1000;
const SESSION_START  = 6;
const SESSION_END    = 22;
const FRIDAY_END     = 20;

// ── entry quality config ──────────────────────────────────────────────────────
const M1_EMA_PERIOD              = 20;
const M1_EMA_MAX_DISTANCE_MULT   = 1.0;
const M1_LATE_ENTRY_ATR_MULT     = 1.8;
const M1_MAX_PRESSURE_BARS       = 4;
const M1_MIN_BODY_TO_ATR_RATIO   = 0.09;
const M1_MAX_WICK_TO_BODY_RATIO  = 4.0;
const M1_CHOP_OVERLAP_THRESHOLD  = 0.85;
const M1_CANDLES_NEEDED          = 25;

// HTF config
const HTF_EMA_PERIOD     = 50;
const HTF_CANDLES_NEEDED = 60;

// News window
const NEWS_WINDOW_START = 25;
const NEWS_WINDOW_END   = 35;

// Dedup
const WEBHOOK_DEDUP_MS = 10_000;

// ── state ─────────────────────────────────────────────────────────────────────
const activeTrades   = new Map();
const lastSignalAt   = new Map();
const lastWebhookAt  = new Map();
const tradeStats     = { total: 0, wins: 0, losses: 0, pnlPts: 0 };

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

async function fetchCandles(ticker, count = M1_CANDLES_NEEDED, interval = "1min") {
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

// ── HTF trend filter (M5 EMA50 + slope) ──────────────────────────────────────
async function getHTFTrend(ticker) {
  const candles = await fetchCandles(ticker, HTF_CANDLES_NEEDED, "5min");
  if (!candles || candles.length < HTF_EMA_PERIOD + 1) {
    console.warn(`[HTF] Za mało świec M5 (${candles?.length ?? 0}) — pomijam HTF filtr`);
    return null;
  }

  const closes = candles.map(c => parseFloat(c.close));
  const price  = closes[closes.length - 1];

  const ema50Curr = calcEMA(closes, HTF_EMA_PERIOD);
  const ema50Prev = calcEMA(closes.slice(0, -1), HTF_EMA_PERIOD);

  if (!ema50Curr || !ema50Prev) {
    console.warn("[HTF] Nie można obliczyć EMA50 M5 — pomijam HTF filtr");
    return null;
  }

  const rising  = ema50Curr > ema50Prev;
  const falling = ema50Curr < ema50Prev;

  let trend = "NEUTRAL";
  if (price > ema50Curr && rising)  trend = "LONG";
  if (price < ema50Curr && falling) trend = "SHORT";

  console.log(
    `[HTF] M5 EMA50=${r(ema50Curr)} (prev=${r(ema50Prev)}, ` +
    `${rising ? "rosnące↑" : falling ? "spadające↓" : "płaskie→"}), ` +
    `cena=${r(price)}, trend=${trend}`
  );
  return trend;
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
    rr1:     r(risk > 0 ? reward1 / risk : 0),
    rr2:     r(risk > 0 ? reward2 / risk : 0),
    rr3:     r(risk > 0 ? reward3 / risk : 0),
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
  if (reason.startsWith("TP")) {
    tradeStats.wins++;
  } else if (reason === "SL") {
    tradeStats.losses++;
  }
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

// ── entry quality engine ──────────────────────────────────────────────────────
function checkEntryQuality(candles, signal) {
  const rejects = [];
  if (!candles || candles.length < 15) return { pass: true, rejects: [], debug: {} };

  const closes = candles.map(c => parseFloat(c.close));
  const highs  = candles.map(c => parseFloat(c.high));
  const lows   = candles.map(c => parseFloat(c.low));
  const currentPrice = closes[closes.length - 1];
  const last2 = candles.slice(-2);
  const last3 = candles.slice(-3);
  const last5 = candles.slice(-5);

  const ema20 = calcEMA(closes, M1_EMA_PERIOD);
  const atr14 = calcATR(candles);
  if (!ema20 || !atr14) return { pass: false, rejects: ["REJECT_BAD_INDICATOR_DATA"], debug: {} };

  // 1. Odległość od EMA20 w wielokrotnościach ATR
  const emaDistAtr = Math.abs(currentPrice - ema20) / atr14;
  if (emaDistAtr > M1_EMA_MAX_DISTANCE_MULT)
    rejects.push(`REJECT_TOO_FAR_FROM_EMA (${emaDistAtr.toFixed(2)}x ATR > max ${M1_EMA_MAX_DISTANCE_MULT}x, dist=${r(Math.abs(currentPrice-ema20))} pkt)`);

  // 2. Spóźniony wejście
  const recentHigh = Math.max(...highs.slice(-10));
  const recentLow  = Math.min(...lows.slice(-10));
  const moveDist   = signal === "SHORT" ? recentHigh - currentPrice : currentPrice - recentLow;
  if (moveDist > M1_LATE_ENTRY_ATR_MULT * atr14)
    rejects.push(`REJECT_LATE_ENTRY (ruch ${moveDist.toFixed(2)} > ${M1_LATE_ENTRY_ATR_MULT}x ATR ${atr14.toFixed(2)})`);

  // 3. Słabe korpusy
  const last3Bodies = last3.map(c => Math.abs(parseFloat(c.close) - parseFloat(c.open)));
  const avgBody = last3Bodies.reduce((a, b) => a + b, 0) / 3;
  if (avgBody < M1_MIN_BODY_TO_ATR_RATIO * atr14)
    rejects.push(`REJECT_WEAK_BODIES (avg body ${avgBody.toFixed(2)} < ${M1_MIN_BODY_TO_ATR_RATIO}x ATR ${atr14.toFixed(2)})`);

  // 4. Presja kierunkowa — minimum 2/3
  const bearish = last3.filter(c => parseFloat(c.close) < parseFloat(c.open)).length;
  const bullish = last3.filter(c => parseFloat(c.close) > parseFloat(c.open)).length;
  if (signal === "SHORT" && bearish < 2) rejects.push(`REJECT_NO_PRESSURE (tylko ${bearish}/3 niedźwiedzich świec)`);
  if (signal === "LONG"  && bullish < 2) rejects.push(`REJECT_NO_PRESSURE (tylko ${bullish}/3 byczych świec)`);

  // 5. Struktura kierunkowa (HH/HL lub LH/LL)
  const last3H = last3.map(c => parseFloat(c.high));
  const last3L = last3.map(c => parseFloat(c.low));
  if (signal === "SHORT" && !(last3H[2] < last3H[1]))
    rejects.push(`REJECT_NO_LOWER_HIGHS (szczyt ${last3H[2].toFixed(2)} nie poniżej ${last3H[1].toFixed(2)})`);
  if (signal === "LONG"  && !(last3L[2] > last3L[1]))
    rejects.push(`REJECT_NO_HIGHER_LOWS (dołek ${last3L[2].toFixed(2)} nie powyżej ${last3L[1].toFixed(2)})`);

  // 6. Wick rejection
  for (const c of last2) {
    const o = parseFloat(c.open), cl = parseFloat(c.close), h = parseFloat(c.high), lo = parseFloat(c.low);
    const body = Math.abs(cl - o);
    if (body < 0.01) continue;
    if (signal === "SHORT") {
      const lw = Math.min(o, cl) - lo;
      if (lw / body > M1_MAX_WICK_TO_BODY_RATIO) {
        rejects.push(`REJECT_WICK_REJECTION (dolny knot ${lw.toFixed(2)} > ${M1_MAX_WICK_TO_BODY_RATIO}x korpus ${body.toFixed(2)})`);
        break;
      }
    } else {
      const uw = h - Math.max(o, cl);
      if (uw / body > M1_MAX_WICK_TO_BODY_RATIO) {
        rejects.push(`REJECT_WICK_REJECTION (górny knot ${uw.toFixed(2)} > ${M1_MAX_WICK_TO_BODY_RATIO}x korpus ${body.toFixed(2)})`);
        break;
      }
    }
  }

  // 7. Chop
  let choppyPairs = 0;
  for (let i = 1; i < last5.length; i++) {
    const pH = parseFloat(last5[i-1].high), pL = parseFloat(last5[i-1].low);
    const cH = parseFloat(last5[i].high),   cL = parseFloat(last5[i].low);
    const overlap = Math.max(0, Math.min(pH, cH) - Math.max(pL, cL));
    const total   = Math.max(pH, cH) - Math.min(pL, cL);
    if (total > 0 && overlap / total > M1_CHOP_OVERLAP_THRESHOLD) choppyPairs++;
  }
  if (choppyPairs >= 3)
    rejects.push(`REJECT_CHOP (${choppyPairs}/4 par świec nakłada się > ${M1_CHOP_OVERLAP_THRESHOLD * 100}%)`);

  // 8. Overextension
  let pressureBars = 0;
  for (let i = last5.length - 1; i >= 0; i--) {
    const isBear = parseFloat(last5[i].close) < parseFloat(last5[i].open);
    const isBull = parseFloat(last5[i].close) > parseFloat(last5[i].open);
    if (signal === "SHORT" && isBear) pressureBars++;
    else if (signal === "LONG" && isBull) pressureBars++;
    else break;
  }
  if (pressureBars >= M1_MAX_PRESSURE_BARS)
    rejects.push(`REJECT_NO_FRESH_IMPULSE (${pressureBars} świec z rzędu >= max ${M1_MAX_PRESSURE_BARS} = overextended)`);

  // 9. Momentum — rosnące korpusy w kierunku sygnału (min 2/3)
  let momentumScore = 0;
  for (let i = last5.length - 3; i < last5.length; i++) {
    const body     = Math.abs(parseFloat(last5[i].close)     - parseFloat(last5[i].open));
    const prevBody = Math.abs(parseFloat(last5[i - 1].close) - parseFloat(last5[i - 1].open));
    if (signal === "LONG"  && parseFloat(last5[i].close) > parseFloat(last5[i].open) && body > prevBody * 1.1) momentumScore++;
    if (signal === "SHORT" && parseFloat(last5[i].close) < parseFloat(last5[i].open) && body > prevBody * 1.1) momentumScore++;
  }
  if (momentumScore < 2)
    rejects.push(`REJECT_WEAK_MOMENTUM (tylko ${momentumScore}/3 mocnych korpusów)`);

  return {
    pass: rejects.length === 0,
    rejects,
    debug: {
      ema20: r(ema20), atr14: r(atr14),
      emaDistAtr: `${emaDistAtr.toFixed(2)}x`,
      moveDist: r(moveDist), avgBody: r(avgBody),
      choppyPairs, pressureBars, momentumScore, currentPrice: r(currentPrice),
    },
  };
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
      const slLabel = trade.tp2Hit ? "TP1 (profit chroniony)" : trade.tp1Hit ? "entry (breakeven)" : "oryginalny SL";
      const pnlSl  = r(trade.signal === "LONG" ? price - trade.entry : trade.entry - price);
      const pnlStr = pnlSl >= 0 ? `+${pnlSl}` : `${pnlSl}`;
      closeTrade(ticker, price, "SL");
      lastSignalAt.set(ticker, Date.now());
      await sendTelegram(
        `🛑 <b>SL HIT — ${ticker} #${trade.id}</b>\n` +
        `Pozycja: ${trade.signal} @ <code>${trade.entry}</code>\n` +
        `SL (<i>${slLabel}</i>): <code>${r(trade.sl)}</code>  |  Cena: <code>${r(price)}</code>\n` +
        `💵 <b>P&L: ${pnlStr} pkt</b>\n` +
        `Otwarto: ${trade.openedAt}\nZamknięto: ${new Date().toUTCString()}`
      );
    }
  }
}

function startPriceMonitor() {
  if (!TWELVEDATA_KEY) { console.warn("[MONITOR] TWELVEDATA_API_KEY nie ustawiony — wyłączony"); return; }
  console.log("[MONITOR] Price monitor uruchomiony (30s open trade / 5min idle)");
  let lastIdleCheck = 0;
  setInterval(async () => {
    const hasOpen = [...activeTrades.values()].some(t => t.status === "OPEN");
    const now = Date.now();
    if (hasOpen) {
      await checkTrades().catch(console.error);
    } else if (now - lastIdleCheck > 5 * 60 * 1000) {
      lastIdleCheck = now;
      await checkTrades().catch(console.error);
    }
  }, 30_000);
}

// ── payload parsing ───────────────────────────────────────────────────────────
function tryParseJson(v) { try { return JSON.parse(v); } catch { return {}; } }

function parseWebhookPayload(body) {
  const raw = typeof body === "string" ? tryParseJson(body) : body ?? {};
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
    const price   = await fetchPrice("XAUUSD");
    const candles = await fetchCandles("XAUUSD", M1_CANDLES_NEEDED);
    const atr     = candles ? (calcATR(candles) ?? DEFAULT_ATR) : DEFAULT_ATR;
    const entry   = price ?? 3300;
    const levels  = buildLevels("LONG", entry, atr);
    const tgResult = await sendTelegram(
      `🧪 <b>TEST SYGNAŁU — XAUUSD LONG</b>\n\n` +
      formatEntry("XAUUSD", "LONG", levels, atr, "1m", "TEST") +
      `\n\n<i>⚠️ To jest sygnał testowy, nie wchodzić w pozycję!</i>`
    );
    res.json({ ok: true, telegram: tgResult, entry, atr: r(atr), levels, note: "Test signal sent. Quality filters bypassed." });
  } catch (err) { res.json({ ok: false, error: String(err) }); }
});

app.get("/admin/close", async (req, res) => {
  const ticker = String(req.query.ticker ?? "XAUUSD").toUpperCase();
  const reason = String(req.query.reason ?? "MANUAL");
  const trade  = activeTrades.get(ticker);
  if (!trade || trade.status !== "OPEN")
    return res.json({ ok: false, reason: `Brak otwartego trade dla ${ticker}` });
  const price = await fetchPrice(ticker) ?? trade.entry;
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

app.head("/webhook", (_req, res) => res.sendStatus(200));
app.get("/webhook",  (_req, res) => res.send("Webhook alive ✅"));

app.post("/webhook", async (req, res) => {
  try {
    const parsed = parseWebhookPayload(req.body);
    const { ticker, signal, entry, tf, strategy } = parsed;
    let   { atr } = parsed;

    console.log("[WEBHOOK] body:", typeof req.body === "string" ? req.body : JSON.stringify(req.body));
    console.log("[WEBHOOK] parsed:", JSON.stringify({ ticker, signal, entry, atr, tf, strategy }));

    if (!signal) return res.status(200).json({ ok: true, accepted: false, reason: "Brak sygnału (LONG/SHORT/BUY/SELL)." });
    if (!ticker) return res.status(200).json({ ok: true, accepted: false, reason: "Brak tickera/symbolu." });
    if (!Number.isFinite(entry)) return res.status(200).json({ ok: true, accepted: false, reason: "Brak prawidłowej ceny entry w payload." });

    // dedup
    const dedupKey = `${ticker}:${signal}`;
    const lastWh   = lastWebhookAt.get(dedupKey);
    if (lastWh && Date.now() - lastWh < WEBHOOK_DEDUP_MS) {
      const ago = ((Date.now() - lastWh) / 1000).toFixed(1);
      console.log(`[DEDUP] Odrzucono ${dedupKey} — duplikat po ${ago}s`);
      return res.status(200).json({ ok: true, accepted: false, reason: `REJECT_DUPLICATE (ten sam sygnał ${ago}s temu)` });
    }
    lastWebhookAt.set(dedupKey, Date.now());

    // świece M1
    const candles = await fetchCandles(ticker, M1_CANDLES_NEEDED, "1min");

    if (candles && candles.length >= 15) {
      const realAtr = calcATR(candles);
      if (realAtr && realAtr >= MIN_ATR && realAtr <= MAX_ATR) {
        console.log(`[ATR] Live ATR: ${r(realAtr)} (payload: ${r(atr)})`);
        atr = realAtr;
      } else {
        console.log(`[ATR] Live ATR ${r(realAtr)} poza zakresem — zostawiam: ${r(atr)}`);
      }
    }

    // quality check M1
    if (candles && candles.length >= 15) {
      const quality = checkEntryQuality(candles, signal);
      console.log(`[QUALITY] ${ticker} ${signal}`, JSON.stringify(quality.debug));
      if (!quality.pass) {
        console.log(`[REJECT] ${ticker} ${signal}: ${quality.rejects.join(" | ")}`);
        return res.status(200).json({
          ok: true, accepted: false,
          reason: "Odrzucony przez filtry jakości", rejects: quality.rejects, debug: quality.debug,
        });
      }
    } else {
      console.warn(`[QUALITY] Brak świec dla ${ticker} — proceduję bez filtrów jakości`);
    }

    // HTF trend filter
    const htfTrend = await getHTFTrend(ticker);
    if (htfTrend !== null && htfTrend !== signal) {
      const reason = `REJECT_HTF_TREND_MISMATCH (sygnał=${signal}, trend M5=${htfTrend})`;
      console.log(`[REJECT] ${ticker}: ${reason}`);
      return res.status(200).json({ ok: true, accepted: false, reason });
    }

    // gate: sesja, cooldown, news, ATR, RR
    const decision = canOpen(ticker, signal, entry, atr);
    if (!decision.ok) {
      console.log(`[REJECT] ${ticker} ${signal}: ${decision.reason}`);
      return res.status(200).json({ ok: true, accepted: false, reason: decision.reason });
    }

    // otwórz trade
    const levels = decision.levels;
    registerTrade(ticker, signal, levels);
    await sendTelegram(formatEntry(ticker, signal, levels, atr, tf, strategy));
    console.log(`[ENTRY] #${activeTrades.get(ticker).id} ${signal} ${ticker} @ ${entry} ATR=${r(atr)} HTF=${htfTrend ?? "N/A"}`);
    return res.status(200).json({
      ok: true, accepted: true, status: "opened",
      id: activeTrades.get(ticker).id, signal, ticker, htfTrend, ...levels,
    });

  } catch (err) {
    console.error("[WEBHOOK] błąd:", err);
    return res.status(200).json({ ok: false, accepted: false, error: String(err) });
  }
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Gold Bot nasłuchuje na porcie ${PORT}`);
  startPriceMonitor();
});
