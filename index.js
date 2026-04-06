return { ok: false, reason: "Outside session (Mon–Fri 06:00–22:00 Warsaw)" };
  }

  const levels = buildLevels(signal, entry, atr);
  if (levels.rr1 < RR_MIN) {
    return { ok: false, reason: RR too low (${levels.rr1} < ${RR_MIN}) };
  }

  return { ok: true, reason: "ACCEPT", levels };
}

function registerTrade(ticker, signal, levels) {
  activeTrades.set(ticker, {
    ticker,
    signal,
    entry: levels.entry,
    sl: levels.sl,
    tp1: levels.tp1,
    tp2: levels.tp2,
    tp3: levels.tp3,
    status: "OPEN",
    openedAt: new Date().toUTCString(),
    tp1Hit: false,
    tp2Hit: false,
    closedAt: null,
    closePrice: null,
    closeReason: null,
  });

  lastSignalAt.set(ticker, Date.now());
}

function closeTrade(ticker, closePrice, reason) {
  const trade = activeTrades.get(ticker);
  if (!trade) return;

  trade.status = "CLOSED";
  trade.closedAt = new Date().toUTCString();
  trade.closePrice = r(closePrice);
  trade.closeReason = reason;
}

function formatEntry(ticker, signal, levels, atr, tf, strategy) {
  const e = signal === "LONG" ? "🟢" : "🔴";
  return (
    ${e} <b>${ticker} ${signal}</b>\n\n +
    <b>Entry:</b> <code>${levels.entry}</code>\n +
    🛡 <b>SL:</b> <code>${levels.sl}</code>  <i>(${levels.slDist} pts)</i>\n +
    🎯 <b>TP1:</b> <code>${levels.tp1}</code>  <i>(${levels.tp1Dist} pts | RR ${levels.rr1})</i>\n +
    🎯🎯 <b>TP2:</b> <code>${levels.tp2}</code>  <i>(${levels.tp2Dist} pts | RR ${levels.rr2})</i>\n +
    🚀 <b>TP3:</b> <code>${levels.tp3}</code>  <i>(${levels.tp3Dist} pts | RR ${levels.rr3})</i>\n +
    📊 <b>ATR:</b> ${atr.toFixed(2)}\n\n +
    <b>TF:</b> ${tf}  |  <b>Strategy:</b> ${strategy}\n +
    <b>Time:</b> ${new Date().toUTCString()}
  );
}

async function sendTelegram(text) {
  if (!BOT_TOKEN) {
    console.error("TELEGRAM_TOKEN not set");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });

    const json = await res.json();
    if (!json.ok) {
      console.error("Telegram error:", json.description);
    }
  } catch (e) {
    console.error("Telegram fetch error:", e);
  }
}

// ── TwelveData helpers ────────────────────────────────────────────────────────
function toTwelveSymbol(ticker) {
  if (ticker === "XAUUSD") return "XAU/USD";
  if (ticker === "XAGUSD") return "XAG/USD";
  return ticker;
}

async function fetchCandles(ticker, count = M1_CANDLES_NEEDED) {
  if (!TWELVEDATA_KEY) return null;

  try {
    const sym = encodeURIComponent(toTwelveSymbol(ticker));
    const url = https://api.twelvedata.com/time_series?symbol=${sym}&interval=1min&outputsize=${count}&apikey=${TWELVEDATA_KEY};
    const res = await fetch(url);
    const json = await res.json();

    if (!json.values || !Array.isArray(json.values)) {
      console.warn(`[CANDLES] TwelveData: ${json.message ?? "no data"}`);
      return null;
    }

    return json.values.slice().reverse();
  } catch (e) {
    console.error("[CANDLES] fetch error:", e);
    return null;
  }
}

async function fetchPrice(ticker) {
  if (!TWELVEDATA_KEY) return null;

  try {
    const url = https://api.twelvedata.com/price?symbol=${encodeURIComponent(toTwelveSymbol(ticker))}&apikey=${TWELVEDATA_KEY};
    const res = await fetch(url);
    const json = await res.json();

    if (json.price) return parseFloat(json.price);

    if (json.message?.includes("symbol") || json.message?.includes("invalid")) {
      return null;
    }

    console.warn(`[MONITOR] TwelveData: ${json.message ?? "no price"}`);
    return null;
  } catch (e) {
    console.error("[MONITOR] fetch error:", e);
    return null;
  }
}

// ── indicators ────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;

  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).
const express = require("express");
const app = express();

app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: true }));

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;
let CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "-1002082257259";
if (CHAT_ID === "-1001808291500") CHAT_ID = "-1002082257259";

// ── config ────────────────────────────────────────────────────────────────────
const MIN_ATR = 1.5;
const MAX_ATR = 10.0;
const DEFAULT_ATR = 5.0;
const RR_MIN = 1.2;
const SL_MULTIPLIER = 1.0;
const TP1_MULTIPLIER = 1.6;
const TP2_MULTIPLIER = 2.5;
const TP3_MULTIPLIER = 5.0;
const COOLDOWN_MS = 15 * 60 * 1000;
const SESSION_START = 6;
const SESSION_END = 22;

// ── entry quality config ──────────────────────────────────────────────────────
const M1_EMA_PERIOD = 20;
const M1_EMA_MAX_DISTANCE_PCT = 0.08;
const M1_LATE_ENTRY_ATR_MULT = 1.2;
const M1_MAX_PRESSURE_BARS = 5;
const M1_MIN_BODY_TO_ATR_RATIO = 0.12;
const M1_MAX_WICK_TO_BODY_RATIO = 2.0;
const M1_CHOP_OVERLAP_THRESHOLD = 0.65;
const M1_CANDLES_NEEDED = 25;

// ── state ─────────────────────────────────────────────────────────────────────
const activeTrades = new Map();
const lastSignalAt = new Map();

// ── helpers ───────────────────────────────────────────────────────────────────
function r(x, d = 2) {
  return Math.round(Number(x) * 10  d) / 10  d;
}

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function normalizeSignal(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  if (["BUY", "LONG"].includes(s)) return "LONG";
  if (["SELL", "SHORT"].includes(s)) return "SHORT";
  return null;
}

function normalizeTicker(v) {
  if (!v) return "XAUUSD";
  const s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.includes("XAUUSD")) return "XAUUSD";
  if (s === "GOLD") return "XAUUSD";
  return s;
}

function getWarsawNowParts() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  return {
    weekday: parts.find(p => p.type === "weekday")?.value ?? "",
    hour: parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10),
    minute: parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10),
  };
}

function isInSession() {
  const { weekday, hour } = getWarsawNowParts();
  return !["Sat", "Sun"].includes(weekday) && hour >= SESSION_START && hour < SESSION_END;
}

function buildLevels(signal, entry, atr) {
  const slD = atr * SL_MULTIPLIER;
  const dir = signal === "LONG" ? 1 : -1;

  return {
    entry: r(entry),
    sl: r(entry - dir * slD),
    tp1: r(entry + dir * slD * TP1_MULTIPLIER),
    tp2: r(entry + dir * slD * TP2_MULTIPLIER),
    tp3: r(entry + dir * slD * TP3_MULTIPLIER),
    rr1: r(TP1_MULTIPLIER),
    rr2: r(TP2_MULTIPLIER),
    rr3: r(TP3_MULTIPLIER),
    slDist: r(slD),
    tp1Dist: r(slD * TP1_MULTIPLIER),
    tp2Dist: r(slD * TP2_MULTIPLIER),
    tp3Dist: r(slD * TP3_MULTIPLIER),
  };
}

function canOpen(ticker, signal, entry, atr) {
  if (atr < MIN_ATR) {
    return { ok: false, reason: ATR too low (${atr.toFixed(2)} < ${MIN_ATR}) };
  }

  if (atr > MAX_ATR) {
    return { ok: false, reason: ATR too high (${atr.toFixed(2)} > ${MAX_ATR}) };
  }

  const active = activeTrades.get(ticker);
  if (active?.status === "OPEN") {
    if (active.signal !== signal) {
      return { ok: true, reason: "REVERSE", reverse: active };
    }
    return { ok: false, reason: Active ${signal} already open on ${ticker} };
  }

  const lastAt = lastSignalAt.get(ticker);
  if (lastAt !== undefined) {
    const elapsed = Date.now() - lastAt;
    if (elapsed < COOLDOWN_MS) {
      const rem = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
      return { ok: false, reason: Cooldown — ${rem} min remaining };
    }
  }

  if (!isInSession()) {
reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return ema;
}

function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const trs = candles.map((c, i, arr) => {
    const h = parseFloat(c.high);
    const lo = parseFloat(c.low);

    if (i === 0) return h - lo;

    const pc = parseFloat(arr[i - 1].close);
    return Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc));
  });

  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── entry quality engine ──────────────────────────────────────────────────────
function checkEntryQuality(candles, signal) {
  const rejects = [];

  if (!candles || candles.length < 15) {
    console.log("[QUALITY] Not enough candles, skipping filters");
    return { pass: true, rejects: [], debug: {} };
  }

  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));

  const currentPrice = closes[closes.length - 1];
  const last2 = candles.slice(-2);
  const last3 = candles.slice(-3);
  const last5 = candles.slice(-5);

  const ema20 = calcEMA(closes, M1_EMA_PERIOD);
  const atr14 = calcATR(candles);

  if (!ema20 || !atr14) {
    return {
      pass: false,
      rejects: ["REJECT_BAD_INDICATOR_DATA"],
      debug: {},
    };
  }

  // C. Distance to EMA
  const emaDist = Math.abs(currentPrice - ema20) / ema20 * 100;
  if (emaDist > M1_EMA_MAX_DISTANCE_PCT) {
    rejects.push(`REJECT_TOO_FAR_FROM_EMA (${emaDist.toFixed(3)}% > max ${M1_EMA_MAX_DISTANCE_PCT}%)`);
  }

  // D. Late entry killer
  const recentHigh = Math.max(...highs.slice(-10));
  const recentLow = Math.min(...lows.slice(-10));
  const moveDist = signal === "SHORT" ? recentHigh - currentPrice : currentPrice - recentLow;

  if (moveDist > M1_LATE_ENTRY_ATR_MULT * atr14) {
    rejects.push(`REJECT_LATE_ENTRY (move ${moveDist.toFixed(2)} > ${M1_LATE_ENTRY_ATR_MULT}x ATR ${atr14.toFixed(2)})`);
  }

  // B. Candle pressure
  const last3Bodies = last3.map(c => Math.abs(parseFloat(c.close) - parseFloat(c.open)));
  const avgBody = last3Bodies.reduce((a, b) => a + b, 0) / 3;

  if (avgBody < M1_MIN_BODY_TO_ATR_RATIO * atr14) {
    rejects.push(`REJECT_WEAK_BODIES (avg body ${avgBody.toFixed(2)} < ${M1_MIN_BODY_TO_ATR_RATIO}x ATR ${atr14.toFixed(2)})`);
  }

  const bearish = last3.filter(c => parseFloat(c.close) < parseFloat(c.open)).length;
  const bullish = last3.filter(c => parseFloat(c.close) > parseFloat(c.open)).length;

  if (signal === "SHORT" && bearish < 2) {
    rejects.push(`REJECT_NO_PRESSURE (only ${bearish}/3 bearish candles)`);
  }
  if (signal === "LONG" && bullish < 2) {
    rejects.push(`REJECT_NO_PRESSURE (only ${bullish}/3 bullish candles)`);
  }

  const last3H = last3.map(c => parseFloat(c.high));
  const last3L = last3.map(c => parseFloat(c.low));

  if (signal === "SHORT") {
    if (!(last3H[1] < last3H[0] && last3H[2] < last3H[1])) {
      rejects.push(`REJECT_NO_LOWER_HIGHS (${last3H.map(h => h.toFixed(2)).join(" > ")} not descending)`);
    }
  } else {
    if (!(last3L[1] > last3L[0] && last3L[2] > last3L[1])) {
      rejects.push(`REJECT_NO_HIGHER_LOWS (${last3L.map(l => l.toFixed(2)).join(" < ")} not ascending)`);
    }
  }

  // G. Wick rejection
  for (const c of last2) {
    const o = parseFloat(c.open);
    const cl = parseFloat(c.close);
    const h = parseFloat(c.high);
    const lo = parseFloat(c.low);
    const body = Math.abs(cl - o);

    if (body < 0.01) continue;

    if (signal === "SHORT") {
      const lowerWick = Math.min(o, cl) - lo;
      if (lowerWick / body > M1_MAX_WICK_TO_BODY_RATIO) {
        rejects.push(`REJECT_WICK_REJECTION (lower wick ${lowerWick.toFixed(2)} > ${M1_MAX_WICK_TO_BODY_RATIO}x body ${body.toFixed(2)})`);
        break;
      }
    } else {
      const upperWick = h - Math.max(o, cl);
      if (upperWick / body > M1_MAX_WICK_TO_BODY_RATIO) {
        rejects.
push(`REJECT_WICK_REJECTION (upper wick ${upperWick.toFixed(2)} > ${M1_MAX_WICK_TO_BODY_RATIO}x body ${body.toFixed(2)})`);
        break;
      }
    }
  }

  // E. Chop / overlap
  let choppyPairs = 0;
  for (let i = 1; i < last5.length; i++) {
    const pH = parseFloat(last5[i - 1].high);
    const pL = parseFloat(last5[i - 1].low);
    const cH = parseFloat(last5[i].high);
    const cL = parseFloat(last5[i].low);

    const overlap = Math.max(0, Math.min(pH, cH) - Math.max(pL, cL));
    const totalRange = Math.max(pH, cH) - Math.min(pL, cL);

    if (totalRange > 0 && overlap / totalRange > M1_CHOP_OVERLAP_THRESHOLD) {
      choppyPairs++;
    }
  }

  if (choppyPairs >= 3) {
    rejects.push(`REJECT_CHOP (${choppyPairs}/4 candle pairs overlapping > ${M1_CHOP_OVERLAP_THRESHOLD * 100}%)`);
  }

  // F. Impulse freshness
  let pressureBars = 0;
  for (let i = last5.length - 1; i >= 0; i--) {
    const isBear = parseFloat(last5[i].close) < parseFloat(last5[i].open);
    const isBull = parseFloat(last5[i].close) > parseFloat(last5[i].open);

    if (signal === "SHORT" && isBear) pressureBars++;
    else if (signal === "LONG" && isBull) pressureBars++;
    else break;
  }

  if (pressureBars >= M1_MAX_PRESSURE_BARS) {
    rejects.push(`REJECT_NO_FRESH_IMPULSE (${pressureBars} consecutive pressure bars ≥ max ${M1_MAX_PRESSURE_BARS})`);
  }

  // EARLY BREAK TRIGGER
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];

  if (signal === "SHORT") {
    if (!(parseFloat(curr.close) < parseFloat(prev.low))) {
      rejects.push("REJECT_NO_BREAK_TRIGGER");
    }
  } else {
    if (!(parseFloat(curr.close) > parseFloat(prev.high))) {
      rejects.push("REJECT_NO_BREAK_TRIGGER");
    }
  }

  return {
    pass: rejects.length === 0,
    rejects,
    debug: {
      ema20: r(ema20),
      atr14: r(atr14),
      emaDist: ${emaDist.toFixed(3)}%,
      moveDist: r(moveDist),
      avgBody: r(avgBody),
      choppyPairs,
      pressureBars,
      currentPrice: r(currentPrice),
    },
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
      trade.tp1Hit = true;
      trade.sl = trade.entry;

      await sendTelegram(
        🎯 <b>TP1 HIT — ${ticker}</b>\n +
        Entry: <code>${trade.entry}</code> → TP1: <code>${r(trade.tp1)}</code>  |  Price: <code>${r(price)}</code>\n\n +
        🔒 <b>SL moved to entry (breakeven): <code>${trade.entry}</code></b>\n +
        🎯🎯 Running to TP2: <code>${r(trade.tp2)}</code>\n +
        <i>${new Date().toUTCString()}</i>
      );
    }

    const tp2Hit = isLong ? price >= trade.tp2 : price <= trade.tp2;
    if (tp2Hit && !trade.tp2Hit) {
      trade.tp1Hit = true;
      trade.tp2Hit = true;
      trade.sl = trade.tp1;

      await sendTelegram(
        🎯🎯 <b>TP2 HIT — ${ticker}</b>\n +
        Entry: <code>${trade.entry}</code> → TP2: <code>${r(trade.tp2)}</code>  |  Price: <code>${r(price)}</code>\n\n +
        🔒 <b>SL moved to TP1 (profit locked): <code>${r(trade.tp1)}</code></b>\n +
        🚀 Still running to TP3: <code>${r(trade.tp3)}</code>\n +
        <i>${new Date().toUTCString()}</i>
      );
    }

    const tp3Hit = isLong ? price >= trade.tp3 : price <= trade.tp3;
    if (tp3Hit) {
      closeTrade(ticker, price, "TP3");
      lastSignalAt.set(ticker, Date.now());

      await sendTelegram(
        🚀 <b>TP3 HIT — FULL CLOSE — ${ticker}</b>\n +
        Was: ${trade.signal} @ <code>${trade.entry}</code>\n +
        TP3: <code>${r(trade.tp3)}</code>  |  Price: <code>${r(price)}</code>\n +
        Opened: ${trade.openedAt}\nClosed: ${new Date().toUTCString()}
      );
      continue;
    }

    const slHit = isLong ? price <= trade.sl : price >= trade.sl;
if (slHit) {
      const slLabel = trade.tp2Hit
        ? "TP1 level (profit protected)"
        : trade.tp1Hit
          ? "entry (breakeven)"
          : "original SL";

      closeTrade(ticker, price, "SL");
      lastSignalAt.set(ticker, Date.now());

      await sendTelegram(
        🛑 <b>SL HIT — ${ticker}</b>\n +
        Was: ${trade.signal} @ <code>${trade.entry}</code>\n +
        SL (<i>${slLabel}</i>): <code>${r(trade.sl)}</code>  |  Price: <code>${r(price)}</code>\n +
        Opened: ${trade.openedAt}\nClosed: ${new Date().toUTCString()}
      );
    }
  }
}

function startPriceMonitor() {
  if (!TWELVEDATA_KEY) {
    console.warn("[MONITOR] TWELVEDATA_API_KEY not set — disabled");
    return;
  }

  console.log("[MONITOR] Price monitor started (every 60s)");
  setInterval(() => checkTrades().catch(console.error), 60_000);
}

// ── payload parsing ───────────────────────────────────────────────────────────
function parseWebhookPayload(body) {
  const raw = typeof body === "string" ? tryParseJson(body) : body ?? {};
  const signal = normalizeSignal(
    raw.signal ?? raw.side ?? raw.action ?? raw.order_action ?? raw.direction
  );

  const ticker = normalizeTicker(
    raw.ticker ?? raw.symbol ?? raw.instrument ?? raw.market ?? "XAUUSD"
  );

  const entry = n(
    raw.entry ?? raw.price ?? raw.close ?? raw.last ?? raw.trigger_price,
    null
  );

  const atr = n(
    raw.atr ?? raw.atr14 ?? raw.atr_14,
    DEFAULT_ATR
  );

  const tf = String(raw.tf ?? raw.timeframe ?? raw.interval ?? "M1");
  const strategy = String(raw.strategy ?? raw.system ?? "TV_WEBHOOK");

  return {
    raw,
    ticker,
    signal,
    entry,
    atr,
    tf,
    strategy,
  };
}

function tryParseJson(v) {
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

// ── routes ────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send("Gold webhook bot running ✅");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    status: "ok",
    uptimeSec: Math.floor(process.uptime()),
    activeTrades: [...activeTrades.values()].filter(t => t.status === "OPEN").length,
    time: new Date().toISOString(),
  });
});

app.head("/webhook", (_req, res) => {
  res.sendStatus(200);
});

app.get("/webhook", (_req, res) => {
  res.send("Webhook alive");
});

app.post("/webhook", async (req, res) => {
  try {
    const parsed = parseWebhookPayload(req.body);

    const { ticker, signal, entry, atr, tf, strategy, raw } = parsed;

    console.log("[WEBHOOK] raw body:", typeof req.body === "string" ? req.body : JSON.stringify(req.body));
    console.log("[WEBHOOK] parsed:", parsed);

    if (!signal) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid signal. Expected LONG/SHORT or BUY/SELL.",
      });
    }

    if (!ticker) {
      return res.status(400).json({
        ok: false,
        error: "Missing ticker/symbol.",
      });
    }

    if (!Number.isFinite(entry)) {
      return res.status(400).json({
        ok: false,
        error: "Missing valid entry/price in webhook payload.",
      });
    }

    // Quality filters from live M1 candles
    const candles = await fetchCandles(ticker, M1_CANDLES_NEEDED);

    if (candles) {
      const quality = checkEntryQuality(candles, signal);

      console.log(`[QUALITY] ${ticker} ${signal}`, quality.debug);

      if (!quality.pass) {
        console.log(`[REJECT] ${ticker} ${signal}: ${quality.rejects.join(" | ")}`);

        return res.status(200).json({
          ok: true,
          accepted: false,
          reason: "Rejected by quality filters",
          rejects: quality.rejects,
          debug: quality.debug,
        });
      }
    } else {
      console.warn(`[QUALITY] No candles fetched for ${ticker}; proceeding without quality filter`);
    }

    const decision = canOpen(ticker, signal, entry, atr);

    if (!decision.ok) {
      console.log(`[REJECT] ${ticker} ${signal}: ${decision.reason}`);

      return res.status(200).json({
        ok: true,
accepted: false,
        reason: decision.reason,
      });
    }

    if (decision.reason === "REVERSE" && decision.reverse) {
      closeTrade(ticker, entry, "REVERSED");
      await sendTelegram(
        🔄 <b>REVERSE — ${ticker}</b>\n +
        Previous trade closed due to opposite signal.\n +
        New direction: <b>${signal}</b>\n +
        Price: <code>${r(entry)}</code>\n +
        <i>${new Date().toUTCString()}</i>
      );
    }

    const levels = decision.levels ?? buildLevels(signal, entry, atr);

    registerTrade(ticker, signal, levels);

    await sendTelegram(
      formatEntry(
        ticker,
        signal,
        levels,
        atr,
        tf,
        ${strategy} + ENTRY_QUALITY_V2
      )
    );

    return res.status(200).json({
      ok: true,
      accepted: true,
      ticker,
      signal,
      entry: r(entry),
      atr: r(atr),
      levels,
      raw,
    });
  } catch (err) {
    console.error("[WEBHOOK] handler error:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal webhook error",
      details: String(err?.message ?? err),
    });
  }
});

app.get("/active-trades", (_req, res) => {
  const trades = [...activeTrades.values()];
  res.status(200).json({
    ok: true,
    count: trades.length,
    trades,
  });
});

app.get("/test-telegram", async (_req, res) => {
  try {
    await sendTelegram(`🧪 <b>Telegram test OK</b>\n<i>${new Date().toUTCString()}</i>`);
    res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.post("/test-signal", async (_req, res) => {
  try {
    const ticker = "XAUUSD";
    const signal = "SHORT";
    const entry = 3300.0;
    const atr = DEFAULT_ATR;

    const decision = canOpen(ticker, signal, entry, atr);
    if (!decision.ok) {
      return res.status(200).json({ ok: true, accepted: false, reason: decision.reason });
    }

    const levels = decision.levels ?? buildLevels(signal, entry, atr);
    registerTrade(ticker, signal, levels);

    await sendTelegram(
      🧪 <b>TEST SIGNAL</b>\n\n +
      formatEntry(ticker, signal, levels, atr, "M1", "LOCAL_TEST")
    );

    return res.status(200).json({ ok: true, accepted: true, levels });
  } catch (e) {
    console.error("[TEST] error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// ── startup ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`[BOOT] Telegram configured: ${Boolean(BOT_TOKEN)}`);
  console.log(`[BOOT] TwelveData configured: ${Boolean(TWELVEDATA_KEY)}`);
  console.log(`[BOOT] Chat ID: ${CHAT_ID}`);
  startPriceMonitor();
});

