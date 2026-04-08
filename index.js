const express = require("express");
const app = express();

app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: true }));

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;
let CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "-1002082257259";
if (CHAT_ID === "-1001808291500") CHAT_ID = "-1002082257259";

// ── config ────────────────────────────────────────────────────────────────────
const MIN_ATR        = 0.5;
const MAX_ATR        = 25.0;
const DEFAULT_ATR    = 5.0;
const RR_MIN         = 1.2;
const SL_MULTIPLIER  = 1.0;
const TP1_MULTIPLIER = 1.6;
const TP2_MULTIPLIER = 2.5;
const TP3_MULTIPLIER = 5.0;
const MIN_SL_DIST    = 5.0;              // minimalny SL w punktach
const MAX_SL_DIST    = 8.0;              // maksymalny SL w punktach
const COOLDOWN_MS    = 10 * 60 * 1000;  // 10 min cooldown
const SESSION_START  = 6;               // Warsaw time
const SESSION_END    = 22;

// ── entry quality config ──────────────────────────────────────────────────────
const M1_EMA_PERIOD             = 20;
const M1_EMA_MAX_DISTANCE_PCT   = 0.25;
const M1_LATE_ENTRY_ATR_MULT    = 3.0;
const M1_MAX_PRESSURE_BARS      = 5;
const M1_MIN_BODY_TO_ATR_RATIO  = 0.06;
const M1_MAX_WICK_TO_BODY_RATIO = 4.0;
const M1_CHOP_OVERLAP_THRESHOLD = 0.85;
const M1_CANDLES_NEEDED         = 25;

// ── state ─────────────────────────────────────────────────────────────────────
const activeTrades = new Map();
const lastSignalAt = new Map();

// ── helpers ───────────────────────────────────────────────────────────────────
function r(x, d = 2) { return Math.round(Number(x) * 10 ** d) / 10 ** d; }
function n(v, fallback = null) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }

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
    timeZone: "Europe/Warsaw", weekday: "short",
    hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(now);
  return {
    weekday: parts.find(p => p.type === "weekday")?.value ?? "",
    hour:    parseInt(parts.find(p => p.type === "hour")?.value   ?? "0", 10),
    minute:  parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10),
  };
}

function isInSession() {
  const { weekday, hour } = getWarsawNowParts();
  return !["Sat", "Sun"].includes(weekday) && hour >= SESSION_START && hour < SESSION_END;
}

function buildLevels(signal, entry, atr) {
  const rawSlD = atr * SL_MULTIPLIER;
  const slD    = Math.min(Math.max(rawSlD, MIN_SL_DIST), MAX_SL_DIST);
  const dir    = signal === "LONG" ? 1 : -1;
  return {
    entry:   r(entry),
    sl:      r(entry - dir * slD),
    tp1:     r(entry + dir * slD * TP1_MULTIPLIER),
    tp2:     r(entry + dir * slD * TP2_MULTIPLIER),
    tp3:     r(entry + dir * slD * TP3_MULTIPLIER),
    rr1:     r(TP1_MULTIPLIER),
    rr2:     r(TP2_MULTIPLIER),
    rr3:     r(TP3_MULTIPLIER),
    slDist:  r(slD),
    tp1Dist: r(slD * TP1_MULTIPLIER),
    tp2Dist: r(slD * TP2_MULTIPLIER),
    tp3Dist: r(slD * TP3_MULTIPLIER),
  };
}

function canOpen(ticker, signal, entry, atr) {
  if (atr < MIN_ATR) return { ok: false, reason: `ATR za niskie (${atr.toFixed(2)} < ${MIN_ATR})` };
  if (atr > MAX_ATR) return { ok: false, reason: `ATR za wysokie (${atr.toFixed(2)} > ${MAX_ATR})` };
  const active = activeTrades.get(ticker);
  if (active?.status === "OPEN") {
    if (active.signal !== signal) return { ok: true, reason: "REVERSE", reverse: active };
    return { ok: false, reason: `Aktywna pozycja ${signal} już otwarta na ${ticker}` };
  }
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
    return { ok: false, reason: `Poza sesją (teraz ${weekday} ${hour}:${String(minute).padStart(2,"0")} Warszawa | sesja Pn–Pt 06:00–22:00)` };
  }
  const levels = buildLevels(signal, entry, atr);
  if (levels.rr1 < RR_MIN) return { ok: false, reason: `RR za niskie (${levels.rr1} < ${RR_MIN})` };
  return { ok: true, reason: "ACCEPT", levels };
}

function registerTrade(ticker, signal, levels) {
  activeTrades.set(ticker, {
    ticker, signal,
    entry: levels.entry, sl: levels.sl,
    tp1: levels.tp1, tp2: levels.tp2, tp3: levels.tp3,
    status: "OPEN", openedAt: new Date().toUTCString(),
    tp1Hit: false, tp2Hit: false,
    closedAt: null, closePrice: null, closeReason: null,
  });
  lastSignalAt.set(ticker, Date.now());
}

function closeTrade(ticker, closePrice, reason) {
  const trade = activeTrades.get(ticker);
  if (!trade) return;
  trade.status      = "CLOSED";
  trade.closedAt    = new Date().toUTCString();
  trade.closePrice  = r(closePrice);
  trade.closeReason = reason;
}

function formatEntry(ticker, signal, levels, atr, tf, strategy) {
  const emoji = signal === "LONG" ? "🟢" : "🔴";
  const dir   = signal === "LONG" ? "LONG  📈" : "SHORT 📉";
  return (
    `${emoji} <b>${ticker} ${dir}</b>\n\n` +
    `💰 <b>Entry:</b> <code>${levels.entry}</code>\n` +
    `🛡 <b>SL:</b>   <code>${levels.sl}</code>  <i>(-${levels.slDist} pkt)</i>\n\n` +
    `🎯 <b>TP1:</b>  <code>${levels.tp1}</code>  <i>(+${levels.tp1Dist} pkt | RR ${levels.rr1})</i>\n` +
    `🎯🎯 <b>TP2:</b> <code>${levels.tp2}</code>  <i>(+${levels.tp2Dist} pkt | RR ${levels.rr2})</i>\n` +
    `🚀 <b>TP3:</b>  <code>${levels.tp3}</code>  <i>(+${levels.tp3Dist} pkt | RR ${levels.rr3})</i>\n\n` +
    `📊 <b>ATR14:</b> ${atr.toFixed(2)}  |  <b>TF:</b> ${tf}\n` +
    `🤖 <i>${strategy}</i>\n` +
    `🕐 <i>${new Date().toUTCString()}</i>`
  );
}

async function sendTelegram(text) {
  if (!BOT_TOKEN) { console.error("[TG] TELEGRAM_TOKEN nie ustawiony"); return { ok: false, error: "no token" }; }
  try {
    const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
    });
    const json = await res.json();
    if (!json.ok) { console.error("[TG] error:", json.description); return { ok: false, error: json.description }; }
    console.log("[TG] Wysłano OK");
    return { ok: true };
  } catch (e) { console.error("[TG] fetch error:", e); return { ok: false, error: String(e) }; }
}

// ── TwelveData ────────────────────────────────────────────────────────────────
function toTwelveSymbol(ticker) {
  if (ticker === "XAUUSD") return "XAU/USD";
  if (ticker === "XAGUSD") return "XAG/USD";
  return ticker;
}

async function fetchCandles(ticker, count = M1_CANDLES_NEEDED) {
  if (!TWELVEDATA_KEY) return null;
  try {
    const sym  = encodeURIComponent(toTwelveSymbol(ticker));
    const url  = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1min&outputsize=${count}&apikey=${TWELVEDATA_KEY}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (!json.values || !Array.isArray(json.values)) { console.warn(`[CANDLES] ${json.message ?? "brak danych"}`); return null; }
    return json.values.slice().reverse();
  } catch (e) { console.error("[CANDLES] error:", e); return null; }
}

async function fetchPrice(ticker) {
  if (!TWELVEDATA_KEY) return null;
  try {
    const url  = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(toTwelveSymbol(ticker))}&apikey=${TWELVEDATA_KEY}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.price) return parseFloat(json.price);
    console.warn(`[MONITOR] ${json.message ?? "brak ceny"}`); return null;
  } catch (e) { console.error("[MONITOR] error:", e); return null; }
}

// ── indicators ────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = candles.map((c, i, arr) => {
    const h = parseFloat(c.high), lo = parseFloat(c.low);
    if (i === 0) return h - lo;
    const pc = parseFloat(arr[i - 1].close);
    return Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
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

  // 1. Odległość od EMA20
  const emaDist = Math.abs(currentPrice - ema20) / ema20 * 100;
  if (emaDist > M1_EMA_MAX_DISTANCE_PCT)
    rejects.push(`REJECT_TOO_FAR_FROM_EMA (${emaDist.toFixed(3)}% > max ${M1_EMA_MAX_DISTANCE_PCT}%)`);

  // 2. Spóźnione wejście
  const recentHigh = Math.max(...highs.slice(-10));
  const recentLow  = Math.min(...lows.slice(-10));
  const moveDist   = signal === "SHORT" ? recentHigh - currentPrice : currentPrice - recentLow;
  if (moveDist > M1_LATE_ENTRY_ATR_MULT * atr14)
    rejects.push(`REJECT_LATE_ENTRY (ruch ${moveDist.toFixed(2)} > ${M1_LATE_ENTRY_ATR_MULT}x ATR ${atr14.toFixed(2)})`);

  // 3. Słabe świece
  const avgBody = last3.map(c => Math.abs(parseFloat(c.close) - parseFloat(c.open))).reduce((a,b)=>a+b,0) / 3;
  if (avgBody < M1_MIN_BODY_TO_ATR_RATIO * atr14)
    rejects.push(`REJECT_WEAK_BODIES (avg body ${avgBody.toFixed(2)} < ${M1_MIN_BODY_TO_ATR_RATIO}x ATR ${atr14.toFixed(2)})`);

  // 4. Brak presji
  const bearish = last3.filter(c => parseFloat(c.close) < parseFloat(c.open)).length;
  const bullish = last3.filter(c => parseFloat(c.close) > parseFloat(c.open)).length;
  if (signal === "SHORT" && bearish < 1) rejects.push(`REJECT_NO_PRESSURE (tylko ${bearish}/3 niedźwiedzich świec)`);
  if (signal === "LONG"  && bullish < 1) rejects.push(`REJECT_NO_PRESSURE (tylko ${bullish}/3 byczych świec)`);

  // 5. Struktura kierunkowa
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
      if (lw / body > M1_MAX_WICK_TO_BODY_RATIO) { rejects.push(`REJECT_WICK_REJECTION (dolny knot ${lw.toFixed(2)} > ${M1_MAX_WICK_TO_BODY_RATIO}x korpus ${body.toFixed(2)})`); break; }
    } else {
      const uw = h - Math.max(o, cl);
      if (uw / body > M1_MAX_WICK_TO_BODY_RATIO) { rejects.push(`REJECT_WICK_REJECTION (górny knot ${uw.toFixed(2)} > ${M1_MAX_WICK_TO_BODY_RATIO}x korpus ${body.toFixed(2)})`); break; }
    }
  }

  // 7. Chop
  let choppyPairs = 0;
  for (let i = 1; i < last5.length; i++) {
    const pH = parseFloat(last5[i-1].high), pL = parseFloat(last5[i-1].low);
    const cH = parseFloat(last5[i].high),   cL = parseFloat(last5[i].low);
    const overlap = Math.max(0, Math.min(pH,cH) - Math.max(pL,cL));
    const total   = Math.max(pH,cH) - Math.min(pL,cL);
    if (total > 0 && overlap / total > M1_CHOP_OVERLAP_THRESHOLD) choppyPairs++;
  }
  if (choppyPairs >= 3) rejects.push(`REJECT_CHOP (${choppyPairs}/4 par nakłada się > ${M1_CHOP_OVERLAP_THRESHOLD*100}%)`);

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
    rejects.push(`REJECT_NO_FRESH_IMPULSE (${pressureBars} świec z rzędu >= max ${M1_MAX_PRESSURE_BARS})`);

  return {
    pass: rejects.length === 0, rejects,
    debug: { ema20: r(ema20), atr14: r(atr14), emaDist: `${emaDist.toFixed(3)}%`, moveDist: r(moveDist), avgBody: r(avgBody), choppyPairs, pressureBars, currentPrice: r(currentPrice) },
  };
}

// ── price monitor ─────────────────────────────────────────────────────────────
async function checkTrades() {
  for (const [ticker, trade] of activeTrades.entries()) {
    if (trade.status !== "OPEN") continue;
    const price = await fetchPrice(ticker);
    if (price === null) continue;
    const isLong = trade.signal === "LONG";

    const tp1Hit = isLong ? price >= trade.tp1 : price <= trade.tp1;
    if (tp1Hit && !trade.tp1Hit) {
      trade.tp1Hit = true; trade.sl = trade.entry;
      await sendTelegram(`🎯 <b>TP1 HIT — ${ticker}</b>\nEntry: <code>${trade.entry}</code> → TP1: <code>${r(trade.tp1)}</code>  |  Cena: <code>${r(price)}</code>\n\n🔒 <b>SL na entry (breakeven): <code>${trade.entry}</code></b>\n🎯🎯 Cel TP2: <code>${r(trade.tp2)}</code>\n<i>${new Date().toUTCString()}</i>`);
    }

    const tp2Hit = isLong ? price >= trade.tp2 : price <= trade.tp2;
    if (tp2Hit && !trade.tp2Hit) {
      trade.tp1Hit = true; trade.tp2Hit = true; trade.sl = trade.tp1;
      await sendTelegram(`🎯🎯 <b>TP2 HIT — ${ticker}</b>\nEntry: <code>${trade.entry}</code> → TP2: <code>${r(trade.tp2)}</code>  |  Cena: <code>${r(price)}</code>\n\n🔒 <b>SL na TP1 (profit locked): <code>${r(trade.tp1)}</code></b>\n🚀 Cel TP3: <code>${r(trade.tp3)}</code>\n<i>${new Date().toUTCString()}</i>`);
    }

    const tp3Hit = isLong ? price >= trade.tp3 : price <= trade.tp3;
    if (tp3Hit) {
      closeTrade(ticker, price, "TP3"); lastSignalAt.set(ticker, Date.now());
      await sendTelegram(`🚀 <b>TP3 HIT — PEŁNE ZAMKNIĘCIE — ${ticker}</b>\nPozycja: ${trade.signal} @ <code>${trade.entry}</code>\nTP3: <code>${r(trade.tp3)}</code>  |  Cena: <code>${r(price)}</code>\nOtwarto: ${trade.openedAt}\nZamknięto: ${new Date().toUTCString()}`);
      continue;
    }

    const slHit = isLong ? price <= trade.sl : price >= trade.sl;
    if (slHit) {
      const slLabel = trade.tp2Hit ? "poziom TP1 (profit chroniony)" : trade.tp1Hit ? "entry (breakeven)" : "oryginalny SL";
      closeTrade(ticker, price, "SL"); lastSignalAt.set(ticker, Date.now());
      await sendTelegram(`🛑 <b>SL HIT — ${ticker}</b>\nPozycja: ${trade.signal} @ <code>${trade.entry}</code>\nSL (<i>${slLabel}</i>): <code>${r(trade.sl)}</code>  |  Cena: <code>${r(price)}</code>\nOtwarto: ${trade.openedAt}\nZamknięto: ${new Date().toUTCString()}`);
    }
  }
}

function startPriceMonitor() {
  if (!TWELVEDATA_KEY) { console.warn("[MONITOR] TWELVEDATA_API_KEY nie ustawiony — wyłączony"); return; }
  console.log("[MONITOR] Price monitor uruchomiony (co 60s)");
  setInterval(() => checkTrades().catch(console.error), 60_000);
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
  ok: true, status: "ok",
  uptimeSec: Math.floor(process.uptime()),
  activeTrades: [...activeTrades.values()].filter(t => t.status === "OPEN").length,
  time: new Date().toISOString(),
  inSession: isInSession(),
}));

app.get("/status", (_req, res) => {
  const trades = [...activeTrades.values()].map(t => ({
    ticker: t.ticker, signal: t.signal, status: t.status,
    entry: t.entry, sl: t.sl, tp1: t.tp1, tp2: t.tp2, tp3: t.tp3,
    tp1Hit: t.tp1Hit, tp2Hit: t.tp2Hit,
    openedAt: t.openedAt, closedAt: t.closedAt ?? null,
    closePrice: t.closePrice ?? null, closeReason: t.closeReason ?? null,
  }));
  const cooldowns = [...lastSignalAt.entries()].map(([ticker, ts]) => ({
    ticker, cooldownMinRemaining: Math.max(0, Math.ceil((COOLDOWN_MS - (Date.now() - ts)) / 60000)),
  }));
  res.json({ botStatus: "running", time: new Date().toUTCString(), inSession: isInSession(), qualityFilterActive: !!TWELVEDATA_KEY, openTrades: trades.filter(t => t.status === "OPEN"), allTrades: trades, cooldowns });
});

// ── /test-signal ──────────────────────────────────────────────────────────────
app.get("/test-signal", async (_req, res) => {
  try {
    const price   = await fetchPrice("XAUUSD");
    const candles = await fetchCandles("XAUUSD", M1_CANDLES_NEEDED);
    const atr     = candles ? (calcATR(candles) ?? DEFAULT_ATR) : DEFAULT_ATR;
    const entry   = price ?? 4800;
    const levels  = buildLevels("LONG", entry, atr);
    const tgResult = await sendTelegram(
      `🧪 <b>TEST SYGNAŁU — XAUUSD LONG</b>\n\n` +
      formatEntry("XAUUSD", "LONG", levels, atr, "1m", "TEST") +
      `\n\n<i>⚠️ To jest sygnał testowy, nie wchodzić w pozycję!</i>`
    );
    res.json({ ok: true, telegram: tgResult, entry, atr: r(atr), levels, note: "Filtry pominięte. SL clamped do 5–8 pkt." });
  } catch (err) { res.json({ ok: false, error: String(err) }); }
});

app.head("/webhook", (_req, res) => res.sendStatus(200));
app.get("/webhook",  (_req, res) => res.send("Webhook alive ✅"));

// ── /webhook ──────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const parsed = parseWebhookPayload(req.body);
    const { ticker, signal, entry, tf, strategy } = parsed;
    let { atr } = parsed;

    console.log("[WEBHOOK] body:", JSON.stringify(req.body));
    console.log("[WEBHOOK] parsed:", JSON.stringify({ ticker, signal, entry, atr, tf, strategy }));

    if (!signal)              return res.status(200).json({ ok: true, accepted: false, reason: "Brak sygnału (LONG/SHORT/BUY/SELL)." });
    if (!ticker)              return res.status(200).json({ ok: true, accepted: false, reason: "Brak tickera." });
    if (!Number.isFinite(entry)) return res.status(200).json({ ok: true, accepted: false, reason: "Brak prawidłowej ceny entry." });

    const candles = await fetchCandles(ticker, M1_CANDLES_NEEDED);
    if (candles && candles.length >= 15) {
      const realAtr = calcATR(candles);
      if (realAtr && realAtr >= MIN_ATR && realAtr <= MAX_ATR) {
        console.log(`[ATR] Live ATR: ${r(realAtr)}`); atr = realAtr;
      }
    }

    if (candles && candles.length >= 15) {
      const quality = checkEntryQuality(candles, signal);
      console.log(`[QUALITY] ${ticker} ${signal}`, JSON.stringify(quality.debug));
      if (!quality.pass) {
        console.log(`[REJECT] ${quality.rejects.join(" | ")}`);
        return res.status(200).json({ ok: true, accepted: false, reason: "Odrzucony przez filtry jakości", rejects: quality.rejects, debug: quality.debug });
      }
    }

    const decision = canOpen(ticker, signal, entry, atr);
    if (!decision.ok) {
      console.log(`[REJECT] ${decision.reason}`);
      return res.status(200).json({ ok: true, accepted: false, reason: decision.reason });
    }

    if (decision.reason === "REVERSE" && decision.reverse) {
      const prev = decision.reverse;
      closeTrade(ticker, entry, "REVERSED");
      const newLevels = buildLevels(signal, entry, atr);
      registerTrade(ticker, signal, newLevels);
      await sendTelegram(`🔄 <b>REVERSAL — ${ticker}</b>\nZamknięto: ${prev.signal} @ <code>${prev.entry}</code>\n\n` + formatEntry(ticker, signal, newLevels, atr, tf, strategy));
      return res.status(200).json({ ok: true, accepted: true, status: "reversed_and_opened", ticker, signal, ...newLevels });
    }

    const levels = decision.levels;
    registerTrade(ticker, signal, levels);
    await sendTelegram(formatEntry(ticker, signal, levels, atr, tf, strategy));
    console.log(`[ENTRY] ${signal} ${ticker} @ ${entry} ATR=${r(atr)} SL=${levels.slDist}pkt`);
    return res.status(200).json({ ok: true, accepted: true, status: "opened", signal, ticker, ...levels });

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
