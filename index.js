const express = require("express");
const app = express();
app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: true }));
const BOT_TOKEN        = process.env.TELEGRAM_TOKEN;
const TWELVEDATA_KEY   = process.env.TWELVEDATA_API_KEY;
let   CHAT_ID          = process.env.TELEGRAM_CHAT_ID ?? "-1002082257259";
if (CHAT_ID === "-1001808291500") CHAT_ID = "-1002082257259";
const MIN_ATR        = 1.5;
const MAX_ATR        = 10.0;
const DEFAULT_ATR    = 5.0;
const RR_MIN         = 1.3;
const SL_MULTIPLIER  = 1.0;
const TP1_MULTIPLIER = 1.6;
const TP2_MULTIPLIER = 2.5;
const TP3_MULTIPLIER = 5.0;
const COOLDOWN_MS    = 30 * 60 * 1000;
const SESSION_START  = 6;
const SESSION_END    = 22;
const activeTrades = new Map();
const lastSignalAt = new Map();
function r(x, d = 2) { return Math.round(x * 10 ** d) / 10 ** d; }
function isInSession() {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    weekday:  "short",
    hour:     "numeric",
    hour12:   false,
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === "weekday")?.value ?? "";
  const hour    = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  return !["Sat", "Sun"].includes(weekday) && hour >= SESSION_START && hour < SESSION_END;
}
function buildLevels(signal, entry, atr) {
  const slD  = atr * SL_MULTIPLIER;
  const tp1D = slD * TP1_MULTIPLIER;
  const tp2D = slD * TP2_MULTIPLIER;
  const tp3D = slD * TP3_MULTIPLIER;
  const dir  = signal === "LONG" ? 1 : -1;
  return {
    entry: r(entry), sl: r(entry - dir * slD),
    tp1: r(entry + dir * tp1D), tp2: r(entry + dir * tp2D), tp3: r(entry + dir * tp3D),
    rr1: r(tp1D / slD), rr2: r(tp2D / slD), rr3: r(tp3D / slD),
    slDist: r(slD), tp1Dist: r(tp1D), tp2Dist: r(tp2D), tp3Dist: r(tp3D),
  };
}
function canOpen(ticker, signal, entry, atr) {
  if (atr < MIN_ATR) return { ok: false, reason: `ATR too low (${atr.toFixed(2)} < ${MIN_ATR})` };
  if (atr > MAX_ATR) return { ok: false, reason: `ATR too high (${atr.toFixed(2)} > ${MAX_ATR})` };
  const active = activeTrades.get(ticker);
  if (active?.status === "OPEN") {
    if (active.signal !== signal) return { ok: true, reason: "REVERSE", reverse: active };
    return { ok: false, reason: `Active ${signal} already open on ${ticker}` };
  }
  const lastAt = lastSignalAt.get(ticker);
  if (lastAt !== undefined) {
    const elapsed = Date.now() - lastAt;
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
      return { ok: false, reason: `Cooldown — ${remaining} min remaining` };
    }
  }
  if (!isInSession()) return { ok: false, reason: "Outside session (Mon–Fri 06:00–22:00 Warsaw)" };
  const levels = buildLevels(signal, entry, atr);
  if (levels.rr1 < RR_MIN) return { ok: false, reason: `RR too low (${levels.rr1} < ${RR_MIN})` };
  return { ok: true, reason: "ACCEPT", levels };
}
function registerTrade(ticker, signal, levels) {
  activeTrades.set(ticker, {
    ticker, signal, entry: levels.entry, sl: levels.sl,
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
  trade.status = "CLOSED";
  trade.closedAt = new Date().toUTCString();
  trade.closePrice = r(closePrice);
  trade.closeReason = reason;
}
function formatEntry(ticker, signal, levels, atr, tf, strategy) {
  const e = signal === "LONG" ? "🟢" : "🔴";
  return (
    `${e} <b>${ticker} ${signal}</b>\n\n` +
    `<b>Entry:</b> <code>${levels.entry}</code>\n` +
    `🛡 <b>SL:</b> <code>${levels.sl}</code>  <i>(${levels.slDist} pts)</i>\n` +
    `🎯 <b>TP1:</b> <code>${levels.tp1}</code>  <i>(${levels.tp1Dist} pts | RR ${levels.rr1})</i>\n` +
    `🎯🎯 <b>TP2:</b> <code>${levels.tp2}</code>  <i>(${levels.tp2Dist} pts | RR ${levels.rr2})</i>\n` +
    `🚀 <b>TP3:</b> <code>${levels.tp3}</code>  <i>(${levels.tp3Dist} pts | RR ${levels.rr3})</i>\n` +
    `📊 <b>ATR:</b> ${atr.toFixed(2)}\n\n` +
    `<b>TF:</b> ${tf}  |  <b>Strategy:</b> ${strategy}\n` +
    `<b>Time:</b> ${new Date().toUTCString()}`
  );
}
async function sendTelegram(text) {
  if (!BOT_TOKEN) { console.error("TELEGRAM_TOKEN not set"); return; }
  try {
    const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
    });
    const json = await res.json();
    if (!json.ok) console.error("Telegram error:", json.description);
  } catch (e) { console.error("Telegram fetch error:", e); }
}
function toTwelveSymbol(ticker) {
  if (ticker === "XAUUSD") return "XAU/USD";
  if (ticker === "XAGUSD") return "XAG/USD";
  return ticker;
}
async function fetchPrice(ticker) {
  if (!TWELVEDATA_KEY) return null;
  try {
    const url  = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(toTwelveSymbol(ticker))}&apikey=${TWELVEDATA_KEY}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.price) return parseFloat(json.price);
    if (json.message?.includes("symbol") || json.message?.includes("invalid")) return null;
    console.warn(`[MONITOR] TwelveData: ${json.message ?? "no price"}`);
    return null;
  } catch (e) { console.error("[MONITOR] fetch error:", e); return null; }
}
async function checkTrades() {
  for (const [ticker, trade] of activeTrades.entries()) {
    if (trade.status !== "OPEN") continue;
    const price = await fetchPrice(ticker);
    if (price === null) continue;
    const isLong = trade.signal === "LONG";
    const tp1Hit = isLong ? price >= trade.tp1 : price <= trade.tp1;
    if (tp1Hit && !trade.tp1Hit) {
      trade.tp1Hit = true;
      trade.sl     = trade.entry;
      await sendTelegram(
        `🎯 <b>TP1 HIT — ${ticker}</b>\n` +
        `Entry: <code>${trade.entry}</code> → TP1: <code>${r(trade.tp1)}</code>  |  Price: <code>${r(price)}</code>\n\n` +
        `🔒 <b>SL moved to entry (breakeven): <code>${trade.entry}</code></b>\n` +
        `🎯🎯 Running to TP2: <code>${r(trade.tp2)}</code>\n` +
        `<i>${new Date().toUTCString()}</i>`
      );
    }
    const tp2Hit = isLong ? price >= trade.tp2 : price <= trade.tp2;
    if (tp2Hit && !trade.tp2Hit) {
      trade.tp1Hit = true;
      trade.tp2Hit = true;
      trade.sl     = trade.tp1;
      await sendTelegram(
        `🎯🎯 <b>TP2 HIT — ${ticker}</b>\n` +
        `Entry: <code>${trade.entry}</code> → TP2: <code>${r(trade.tp2)}</code>  |  Price: <code>${r(price)}</code>\n\n` +
        `🔒 <b>SL moved to TP1 (profit locked): <code>${r(trade.tp1)}</code></b>\n` +
        `🚀 Still running to TP3: <code>${r(trade.tp3)}</code>\n` +
        `<i>${new Date().toUTCString()}</i>`
      );
    }
    const tp3Hit = isLong ? price >= trade.tp3 : price <= trade.tp3;
    if (tp3Hit) {
      closeTrade(ticker, price, "TP3");
      lastSignalAt.set(ticker, Date.now());
      await sendTelegram(
        `🚀 <b>TP3 HIT — FULL CLOSE — ${ticker}</b>\n` +
        `Was: ${trade.signal} @ <code>${trade.entry}</code>\n` +
        `TP3: <code>${r(trade.tp3)}</code>  |  Price: <code>${r(price)}</code>\n` +
        `Opened: ${trade.openedAt}\nClosed: ${new Date().toUTCString()}`
      );
      continue;
    }
    const slHit = isLong ? price <= trade.sl : price >= trade.sl;
    if (slHit) {
      const slLabel = trade.tp2Hit ? "TP1 level (profit protected)"
                    : trade.tp1Hit ? "entry (breakeven)" : "original SL";
      closeTrade(ticker, price, "SL");
      lastSignalAt.set(ticker, Date.now());
      await sendTelegram(
        `🛑 <b>SL HIT — ${ticker}</b>\n` +
        `Was: ${trade.signal} @ <code>${trade.entry}</code>\n` +
        `SL (<i>${slLabel}</i>): <code>${r(trade.sl)}</code>  |  Price: <code>${r(price)}</code>\n` +
        `Opened: ${trade.openedAt}\nClosed: ${new Date().toUTCString()}`
      );
    }
  }
}
function startPriceMonitor() {
  if (!TWELVEDATA_KEY) { console.warn("[MONITOR] TWELVEDATA_API_KEY not set — disabled"); return; }
  console.log("[MONITOR] Price monitor started (every 30s)");
  setInterval(() => checkTrades().catch(console.error), 30_000);
}
app.get("/", (_req, res) => res.send("Gold webhook bot running ✅"));
app.head("/webhook", (_req, res) => res.sendStatus(200));
app.get("/webhook", (_req, res) => res.send("Gold webhook bot running ✅"));
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
      await sendTelegram(`⚠️ <b>Raw alert</b>\n${String(req.body ?? "").trim()}\n<i>${new Date().toUTCString()}</i>`);
      return res.json({ status: "ok", mode: "raw_text" });
    }
    const signal    = String(data.signal ?? "UNKNOWN").toUpperCase();
    const ticker    = String(data.ticker ?? "XAUUSD").toUpperCase();
    const timeframe = data.timeframe ?? "1m";
    const strategy  = data.strategy  ?? "Gold PRO Signal M1";
    const rawPrice  = data.price ?? data.close;
    if (signal !== "LONG" && signal !== "SHORT")
      return res.json({ status: "skipped", reason: `Unknown signal: ${signal}` });
    const entry = rawPrice !== undefined ? parseFloat(String(rawPrice)) : NaN;
    if (isNaN(entry)) return res.json({ status: "error", reason: "price missing" });
    let atr = data.atr !== undefined ? parseFloat(String(data.atr)) : NaN;
    if (isNaN(atr) || atr > 100) { console.log(`[ATR] fallback → ${DEFAULT_ATR}`); atr = DEFAULT_ATR; }
    const { ok, reason, levels, reverse } = canOpen(ticker, signal, entry, atr);
    if (ok && reason === "REVERSE" && reverse) {
      closeTrade(ticker, entry, "REVERSED");
      lastSignalAt.set(ticker, Date.now());
      await sendTelegram(
        `🔄 <b>REVERSED — ${ticker}</b>\n` +
        `Closed: ${reverse.signal} @ <code>${reverse.entry}</code>\n` +
        `At price: <code>${r(entry)}</code>\nNext signal in 30 min\n` +
        `<i>${new Date().toUTCString()}</i>`
      );
      return res.json({ status: "reversed", ticker });
    }
    if (!ok) { console.log(`[FILTERED] ${signal} ${ticker}: ${reason}`); return res.json({ status: "filtered", reason }); }
    registerTrade(ticker, signal, levels);
    await sendTelegram(formatEntry(ticker, signal, levels, atr, timeframe, strategy));
    console.log(`[ENTRY] ${signal} ${ticker} @ ${entry} ATR=${atr}`);
    return res.json({ status: "ok", signal, ticker, ...levels });
  } catch (err) {
    console.error("[WEBHOOK] error:", err);
    return res.status(500).json({ status: "error", message: String(err) });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Bot listening on port ${PORT}`); startPriceMonitor(); });
