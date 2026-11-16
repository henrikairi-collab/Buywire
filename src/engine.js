import { wsUrl, createChain, syncHeliusWebhook } from "./chain.js";
import { parseEnhancedTransaction, parseRawTransaction, normalizeAmount, uiApproxRaw } from "./parse.js";
import { createPrices } from "./prices.js";
import { decideEntry } from "./rules.js";
import {
  chunkText,
  emojiBar,
  escapeHtml,
  formatDuration,
  formatRaw,
  formatTimestamp,
  formatTokenUi,
  formatUiString,
  formatUsd,
  shortAddress,
  uiStringToRaw,
} from "./format.js";

const DEFAULT_TIERS = [
  { min: "10", emoji: "🟢" },
  { min: "50", emoji: "🔥" },
  { min: "100", emoji: "🐳" },
];
const OLD_TOKEN_TIERS = JSON.stringify([
  { min: "1000", emoji: "🟢" },
  { min: "10000", emoji: "🔥" },
  { min: "100000", emoji: "🐳" },
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEngine(ctx) {
  const chain = createChain(ctx.config, ctx.log);
  const prices = createPrices(ctx.log);
  const status = ctx.status;
  let running = false;
  let socket = null;
  let reconnectTimer = null;
  let filling = false;
  let attempt = 0;
  const balanceRetries = new Set();

  function mint() {
    return ctx.db.getSetting("token_mint") || "";
  }

  function symbol() {
    return ctx.db.getSetting("token_symbol") || ctx.config.symbol || "TOKEN";
  }

  function decimals() {
    const value = ctx.db.getSetting("token_decimals");
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
  }

  function tiers() {
    try {
      const parsed = JSON.parse(ctx.db.getSetting("emoji_tiers") || "[]");
      return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_TIERS;
    } catch {
      return DEFAULT_TIERS;
    }
  }

  function publicUrl() {
    return (ctx.db.getSetting("public_url") || ctx.config.publicUrl || "").replace(/\/$/, "");
  }

  async function ensureMeta() {
    const current = mint();
    if (!current) return;
    if (decimals() == null) {
      try {
        const info = await chain.mintInfo(current);
        if (info) ctx.db.setSetting("token_decimals", String(info.decimals));
      } catch (err) {
        ctx.log.warn("mint decimals lookup failed", { err });
      }
    }
    if (!ctx.db.getSetting("token_symbol")) {
      const priced = await prices.token(current);
      const discovered = priced.symbol || (await chain.assetSymbol(current));
      if (discovered) ctx.db.setSetting("token_symbol", discovered);
    }
  }

  function remembered(signature) {
    const row = ctx.db.seen(signature);
    if (!row?.effects) return false;
    return row.alert === "sent" || row.alert === "skip" || row.alert === "failed";
  }

  async function priceOf(buy) {
    const token = await prices.token(mint());
    const sol = buy.solSpent > 0 ? await prices.sol() : { usd: null };
    return prices.usdValue({
      amountUi: buy.amountUi,
      solSpent: buy.solSpent,
      quoteSymbol: buy.quoteSymbol,
      quoteUi: buy.quoteUi,
      tokenUsd: token.usd,
      solUsd: sol.usd,
    });
  }

  async function renderAlert(buy, usd, holdingUi) {
    const bar = emojiBar(usd, tiers(), ctx.db.getSetting("emoji_mode") || "tiers", ctx.db.getSetting("custom_emoji") || "");
    const amount = Number.isFinite(buy.amountUi) ? formatTokenUi(buy.amountUi) : formatRaw(buy.amountRaw, buy.decimals || decimals() || 0);
    const walletUrl = `https://solscan.io/account/${buy.wallet}`;
    const txUrl = `https://solscan.io/tx/${buy.signature}`;
    const lines = [
      `${escapeHtml(bar)} <b>${escapeHtml(symbol())} BUY</b>`,
      "",
      `💰 <b>${escapeHtml(formatUsd(usd))}</b>`,
      `🪙 <b>${escapeHtml(amount)}</b> ${escapeHtml(symbol())}`,
      `👤 <a href="${walletUrl}">${escapeHtml(shortAddress(buy.wallet))}</a>`,
    ];
    if (holdingUi != null) lines.push(`💼 <b>${escapeHtml(formatTokenUi(holdingUi))}</b> held now`);
    lines.push(
      `🏪 ${escapeHtml(buy.dex || "DEX")}`,
      `🕒 ${escapeHtml(formatTimestamp(buy.timestamp))}`,
      "",
      `🔗 <a href="${txUrl}">View transaction</a>`,
    );
    return lines.join("\n");
  }

  function underMinimum(usd) {
    const min = Number(ctx.db.getSetting("min_buy_usd") || "0");
    if (!(min > 0)) return false;
    if (usd == null || !Number.isFinite(usd)) return false;
    return usd + 1e-9 < min;
  }

  async function applyEffectsClean(parsed) {
    const comp = ctx.db.activeCompetition();
    const buys = new Map();
    for (const buy of parsed.buys) buys.set(buy.wallet, BigInt(buy.amountRaw));
    if (!comp) {
      for (const [wallet, raw] of buys) ctx.db.recordBuy(parsed.signature, wallet, raw.toString());
      return [];
    }
    const sells = new Map();
    const dec = comp.decimals;
    for (const change of parsed.changes || []) {
      if (!(change.deltaUi < 0)) continue;
      if (!ctx.db.competitor(comp.id, change.wallet) && !buys.has(change.wallet)) continue;
      sells.set(change.wallet, BigInt(uiApproxRaw(Math.abs(change.deltaUi), dec)));
    }
    const wallets = new Set([...buys.keys(), ...sells.keys()]);
    const notes = [];
    for (const wallet of wallets) {
      const buyRaw = buys.get(wallet) || 0n;
      const already = buyRaw > 0n && ctx.db.hasBuy(parsed.signature, wallet);
      const note = settleWallet(comp, wallet, {
        buyRaw: already ? 0n : buyRaw,
        sellRaw: sells.get(wallet) || 0n,
      });
      if (buyRaw > 0n) ctx.db.recordBuy(parsed.signature, wallet, buyRaw.toString());
      notes.push({ wallet, ...note });
    }
    return notes;
  }

  function settleWallet(comp, wallet, { buyRaw, sellRaw }) {
    const existing = ctx.db.competitor(comp.id, wallet);
    if (!existing && buyRaw <= 0n) return { entered: false, disqualified: false };
    const previous =
      existing?.status === "eligible" || existing?.status === "disqualified" ? existing.status : "watching";
    const bought = BigInt(existing?.total_bought_raw || "0") + buyRaw;
    const sold = BigInt(existing?.sold_raw || "0") + sellRaw;
    const position = bought > sold ? bought - sold : 0n;
    const next = decideEntry({
      status: previous,
      positionRaw: position,
      thresholdRaw: BigInt(comp.threshold_raw),
      entriesOpen: comp.status === "active",
    });
    if (next === "watching" && bought === 0n) return { entered: false, disqualified: false };
    let enteredAt = existing?.entered_at ?? null;
    let disqualifiedAt = existing?.disqualified_at ?? null;
    const entered = next === "eligible" && previous !== "eligible";
    const disqualified = next === "disqualified" && previous === "eligible";
    if (entered) {
      enteredAt = Date.now();
      disqualifiedAt = null;
    }
    if (disqualified) disqualifiedAt = Date.now();
    ctx.db.upsertCompetitor({
      competitionId: comp.id,
      wallet,
      enteredAt,
      totalBoughtRaw: bought.toString(),
      balanceRaw: position.toString(),
      soldRaw: sold.toString(),
      status: next,
      disqualifiedAt,
    });
    return { entered, disqualified, positionRaw: position, boughtRaw: bought };
  }

  async function notify(text) {
    if (!ctx.telegram?.notifyAdmins) return;
    try {
      await ctx.telegram.notifyAdmins(text);
    } catch (err) {
      ctx.log.error("admin notify failed", { err });
    }
  }

  async function flushOutbox() {
    const rows = ctx.db.pendingOutbox(25);
    const bySig = new Map();
    for (const row of rows) {
      const list = bySig.get(row.signature) || [];
      list.push(row);
      bySig.set(row.signature, list);
    }
    for (const [signature, items] of bySig) {
      let failed = false;
      let rejected = false;
      for (const item of items) {
        const payload = JSON.parse(item.payload);
        const ok = await deliver(payload);
        if (ok === "sent" || ok === "failed") ctx.db.dropOutbox(signature, item.wallet);
        if (ok === "failed") rejected = true;
        if (ok === "pending") failed = true;
      }
      if (failed) ctx.db.setAlertFlag(signature, "pending");
      else ctx.db.setAlertFlag(signature, rejected ? "failed" : "sent");
    }
  }

  async function deliver(buy) {
    const chatId = ctx.db.getSetting("alert_chat_id");
    if (!chatId) {
      ctx.log.error("buy is waiting because no alert chat is set", { signature: buy.signature, wallet: buy.wallet });
      return "pending";
    }
    if (!ctx.telegram?.sendAlert) return "pending";
    let usd = null;
    try {
      usd = await priceOf(buy);
    } catch (err) {
      ctx.log.warn("price failed", { err });
    }
    let holdingUi = null;
    try {
      const bal = await chain.balanceRaw(buy.wallet, mint());
      const dec = bal.decimals ?? buy.decimals ?? decimals() ?? 0;
      holdingUi = Number(bal.raw) / 10 ** dec;
    } catch (err) {
      ctx.log.warn("holding balance failed", { wallet: buy.wallet, err });
    }
    const text = await renderAlert(buy, usd, holdingUi);
    try {
      const message = await ctx.telegram.sendAlert(chatId, text);
      ctx.db.recordAlert({
        signature: buy.signature,
        wallet: buy.wallet,
        amountUi: buy.amountUi,
        usd,
        dex: buy.dex,
        ts: buy.timestamp,
        chatId,
        messageId: message?.message_id ?? null,
      });
      status.lastAlertAt = Date.now();
      ctx.log.info("buy alert sent", {
        signature: buy.signature,
        wallet: buy.wallet,
        amount: buy.amountUi,
        usd,
        dex: buy.dex,
      });
      return "sent";
    } catch (err) {
      const code = err.code;
      if (err.migrateTo) {
        ctx.db.setSetting("alert_chat_id", String(err.migrateTo));
        ctx.log.warn("alert chat migrated", { chatId: err.migrateTo });
        return "pending";
      }
      if (code === 400 || code === 403) {
        ctx.log.error("buy alert rejected; full text is in this log", {
          signature: buy.signature,
          wallet: buy.wallet,
          text,
          err,
        });
        return "failed";
      }
      ctx.log.error("buy alert failed; will retry", { signature: buy.signature, wallet: buy.wallet, err });
      return "pending";
    }
  }

  async function queueAlerts(parsed) {
    const accepted = [];
    let ignored = 0;
    for (const buy of parsed.buys) {
      let usd = null;
      try {
        usd = await priceOf(buy);
      } catch (err) {
        ctx.log.warn("price failed", { err });
      }
      if (underMinimum(usd)) {
        ignored += 1;
        continue;
      }
      accepted.push({ ...buy, usd });
    }
    if (ignored > 0) {
      ctx.log.info("buys under minimum ignored", { signature: parsed.signature, ignored });
    }
    if (!accepted.length) {
      if (!ctx.db.pendingOutbox(1).some((row) => row.signature === parsed.signature)) {
        ctx.db.setAlertFlag(parsed.signature, "skip");
      }
      return;
    }
    for (const buy of accepted) {
      ctx.db.enqueueAlert(parsed.signature, buy.wallet, buy);
    }
    ctx.db.setAlertFlag(parsed.signature, "pending");
    await flushOutbox();
  }

  async function handleParsed(parsed) {
    if (!parsed?.signature) return;
    if (remembered(parsed.signature)) return;
    const existing = ctx.db.seen(parsed.signature);
    if (!existing && !ctx.db.claim(parsed.signature)) {
      if (remembered(parsed.signature)) return;
    }
    try {
      let notes = [];
      if (!ctx.db.seen(parsed.signature)?.effects) {
        await ensureMeta();
        parsed.buys = (parsed.buys || []).map((buy) => normalizeAmount(buy, decimals()));
        notes = await applyEffectsClean(parsed);
        ctx.db.markEffects(parsed.signature);
      }
      await queueAlerts(parsed);
      status.lastTxAt = parsed.timestamp ? parsed.timestamp * 1000 : Date.now();
      for (const note of notes) {
        if (note.entered) {
          const comp = ctx.db.activeCompetition();
          if (comp) await announceEntry(note.wallet, comp, note.positionRaw);
        } else if (note.disqualified) {
          await announceDisqualified(note.wallet);
        }
      }
    } catch (err) {
      const row = ctx.db.seen(parsed.signature);
      if (row && !row.effects) ctx.db.release(parsed.signature);
      throw err;
    }
  }

  async function ingestSignature(signature) {
    if (!signature || remembered(signature)) return;
    const current = mint();
    if (!current) return;
    let parsed = null;
    try {
      const enhanced = await chain.heliusParse([signature]);
      if (enhanced[0]) parsed = parseEnhancedTransaction(enhanced[0], current);
    } catch (err) {
      ctx.log.warn("enhanced parse failed; using raw transaction", { signature, err });
    }
    if (!parsed) {
      const raw = await chain.transaction(signature);
      if (!raw) return;
      parsed = parseRawTransaction(raw, current, signature);
    }
    if (parsed) await handleParsed(parsed);
  }

  async function ingestEnhanced(tx) {
    const current = mint();
    if (!current) return;
    const parsed = parseEnhancedTransaction(tx, current);
    if (parsed) await handleParsed(parsed);
  }

  async function backfill() {
    if (filling) return;
    const current = mint();
    if (!current || !ctx.config.rpc) return;
    filling = true;
    try {
      await ensureMeta();
      const bootKey = `bootstrapped:${current}`;
      if (ctx.db.getSetting(bootKey) !== "1") {
        const sigs = await chain.signatures(current);
        const newest = sigs.find((row) => !row.err);
        if (newest) {
          if (ctx.db.claim(newest.signature) || ctx.db.seen(newest.signature)) {
            ctx.db.markEffects(newest.signature);
            ctx.db.setAlertFlag(newest.signature, "skip");
          }
        }
        ctx.db.setSetting(bootKey, "1");
        ctx.log.info("bootstrap cursor set; history before startup is not replayed", {
          signature: newest?.signature || null,
        });
        return;
      }
      const missed = [];
      let before;
      let anchored = false;
      for (let page = 0; page < 100 && !anchored; page += 1) {
        const sigs = await chain.signatures(current, before);
        if (!sigs.length) break;
        for (const row of sigs) {
          if (row.err) continue;
          const partial = ctx.db.seen(row.signature);
          if (partial?.effects) {
            anchored = true;
            break;
          }
          missed.push(row.signature);
        }
        before = sigs[sigs.length - 1].signature;
        if (sigs.length < 100) break;
      }
      if (!anchored && missed.length) {
        ctx.log.error("backfill never reached a known signature", { scanned: missed.length });
      }
      missed.reverse();
      if (missed.length) ctx.log.info("backfill catching missed signatures", { count: missed.length });
      for (const signature of missed) {
        try {
          await ingestSignature(signature);
        } catch (err) {
          ctx.log.error("backfill item failed", { signature, err });
        }
        await sleep(80);
      }
    } catch (err) {
      ctx.log.error("backfill failed", { err });
    } finally {
      filling = false;
    }
  }

  function connectSocket() {
    if (!running) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const url = wsUrl(ctx.config);
    const current = mint();
    if (!url || !current || typeof WebSocket === "undefined") {
      status.stream = "down";
      reconnectTimer = setTimeout(connectSocket, 5_000);
      return;
    }
    status.stream = "connecting";
    let next;
    try {
      next = new WebSocket(url);
    } catch (err) {
      ctx.log.error("websocket construct failed", { err });
      status.stream = "down";
      reconnectTimer = setTimeout(connectSocket, 5_000);
      return;
    }
    socket = next;
    let last = Date.now();
    const watchdog = setInterval(() => {
      if (socket === next && Date.now() - last > 90_000) {
        ctx.log.warn("websocket silent; reconnecting");
        next.close();
      }
    }, 15_000);
    next.addEventListener("open", () => {
      if (socket !== next) return;
      attempt = 0;
      status.stream = "live";
      last = Date.now();
      next.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [current] }, { commitment: "confirmed" }],
        }),
      );
      ctx.log.info("websocket live", { mint: current });
    });
    next.addEventListener("message", (event) => {
      last = Date.now();
      try {
        const message = JSON.parse(String(event.data));
        const value = message.params?.result?.value;
        if (!value?.signature || value.err) return;
        ingestSignature(value.signature).catch((err) => {
          ctx.log.error("streamed transaction failed", { signature: value.signature, err });
        });
      } catch (err) {
        ctx.log.warn("websocket payload ignored", { err });
      }
    });
    const schedule = () => {
      clearInterval(watchdog);
      if (socket === next) status.stream = "down";
      if (!running) return;
      attempt += 1;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      reconnectTimer = setTimeout(connectSocket, wait);
    };
    next.addEventListener("close", schedule);
    next.addEventListener("error", () => next.close());
  }

  async function syncWebhook() {
    try {
      const result = await syncHeliusWebhook({
        config: ctx.config,
        log: ctx.log,
        mint: mint(),
        publicUrl: publicUrl(),
        secret: ctx.config.webhookSecret,
        existingId: ctx.db.getSetting("helius_webhook_id"),
      });
      status.webhook = result.state;
      if (result.id) ctx.db.setSetting("helius_webhook_id", result.id);
    } catch (err) {
      status.webhook = "error";
      ctx.log.error("webhook sync failed", { err });
    }
  }

  async function refreshCompetitors() {
    return;
  }

  async function drainBalanceRetries() {
    const jobs = [...balanceRetries];
    balanceRetries.clear();
    for (const job of jobs) {
      try {
        const { competitionId, wallet } = JSON.parse(job);
        const comp = ctx.db.competition(competitionId);
        if (!comp || (comp.status !== "active" && comp.status !== "holding")) continue;
        const note = settleWallet(comp, wallet, { buyRaw: 0n, sellRaw: 0n });
        if (note.disqualified) await announceDisqualified(wallet);
      } catch (err) {
        ctx.log.error("deferred balance refresh failed", { err });
        balanceRetries.add(job);
      }
    }
  }

  function competitionReport(comp, heading) {
    const eligible = ctx.db.competitors(comp.id, "eligible");
    const dq = ctx.db.competitors(comp.id, "disqualified");
    const lines = [
      `<b>${heading}</b>`,
      `Prize: ${escapeHtml(comp.prize_text)}`,
      `Threshold: ${escapeHtml(formatUiString(comp.threshold_ui))} ${escapeHtml(symbol())}`,
      `Window: ${comp.duration_days} day(s)`,
      `Still eligible: ${eligible.length}`,
      "",
    ];
    if (!eligible.length) lines.push("No wallet is still above the threshold.", "");
    eligible.forEach((row, index) => {
      const held = Math.max(0, comp.ends_at - (row.entered_at || comp.started_at));
      lines.push(
        `${index + 1}. <code>${escapeHtml(row.wallet)}</code>`,
        `Bought: ${escapeHtml(formatRaw(row.total_bought_raw, comp.decimals))} ${escapeHtml(symbol())}`,
        `Still in comp: ${escapeHtml(formatRaw(row.balance_raw, comp.decimals))} ${escapeHtml(symbol())}`,
        `Held above threshold: ${formatDuration(held)}`,
        "",
      );
    });
    lines.push(`Disqualified: ${dq.length}`);
    lines.push("", "Full addresses are above. Copy them for the giveaway.");
    return lines.join("\n");
  }

  async function closeDueCompetitions() {
    const due = ctx.db.dueCompetitions(Date.now());
    for (const comp of due) {
      try {
        await refreshCompetitors();
        const fresh = ctx.db.competition(comp.id);
        const text = competitionReport(fresh, "Buy comp finished");
        for (const part of chunkText(text)) await notify(part);
        ctx.db.markSummarySent(comp.id);
        ctx.log.info("competition summary sent", { id: comp.id });
      } catch (err) {
        ctx.log.error("competition summary failed; will retry", { id: comp.id, err });
      }
    }
  }

  function renderAnnouncement(comp) {
    return [
      "🏆 <b>BUY COMP IS LIVE</b>",
      "",
      `${escapeHtml(symbol())} hold contest`,
      "",
      `Prize: <b>${escapeHtml(comp.prize_text)}</b>`,
      `Entry: <b>${escapeHtml(formatUiString(comp.threshold_ui))}</b> ${escapeHtml(symbol())}`,
      `Hold: <b>${escapeHtml(String(comp.duration_days))}</b> day(s)`,
      `Ends: ${escapeHtml(formatTimestamp(Math.floor(comp.ends_at / 1000)))}`,
      "",
      "Buy at least the entry size and keep that balance until the end.",
      "Drop under the line and you are out for good.",
      "",
      "Type /buycomplb in this chat for every entry and the time left.",
    ].join("\n");
  }

  async function postToGroup(text, media) {
    const chatId = ctx.db.getSetting("alert_chat_id");
    if (chatId && ctx.telegram?.sendCard) {
      try {
        await ctx.telegram.sendCard(chatId, text, media?.type || "", media?.fileId || "");
        return true;
      } catch (err) {
        ctx.log.error("group post failed", { err });
      }
    }
    await notify(text);
    return false;
  }

  async function announceCompetition(comp) {
    if (!comp || comp.announced) return Boolean(comp?.announced);
    const posted = await postToGroup(renderAnnouncement(comp), {
      type: comp.media_type,
      fileId: comp.media_file_id,
    });
    if (posted) ctx.db.markAnnounced(comp.id);
    return posted;
  }

  async function announceActive() {
    const comp = ctx.db.activeCompetition();
    if (!comp || comp.announced) return false;
    return announceCompetition(comp);
  }

  async function announceDisqualified(wallet) {
    const url = `https://solscan.io/account/${wallet}`;
    await notify(
      [
        "<b>Disqualified</b>",
        `<code>${escapeHtml(wallet)}</code>`,
        "Sold or transferred below the entry size. Out for good.",
      ].join("\n"),
    );
    await postToGroup(
      [
        "🚫 <b>DISQUALIFIED</b>",
        "",
        `<a href="${url}">${escapeHtml(shortAddress(wallet))}</a>`,
        "Balance dropped under the entry size.",
      ].join("\n"),
    );
  }

  async function announceEntry(wallet, comp, positionRaw) {
    const left = Math.max(0, comp.ends_at - Date.now());
    const url = `https://solscan.io/account/${wallet}`;
    const bought = positionRaw == null ? "n/a" : formatTokenUi(Number(positionRaw) / 10 ** comp.decimals);
    await postToGroup(
      [
        "🔥 <b>NEW ENTRY</b>",
        "",
        `<a href="${url}">${escapeHtml(shortAddress(wallet))}</a>`,
        `Bought since start: <b>${escapeHtml(bought)}</b> ${escapeHtml(symbol())}`,
        `Eligible in ${formatDuration(left)}`,
      ].join("\n"),
    );
  }

  function leaderboardText() {
    const comp = ctx.db.activeCompetition();
    if (!comp) return "No buy comp is running.";
    const rows = ctx.db.competitors(comp.id, "eligible");
    const closed = comp.status === "holding";
    const leftMs = comp.ends_at - Date.now();
    const left = formatDuration(Math.max(0, leftMs));
    const lines = [
      "<b>BUY COMP</b>",
      escapeHtml(comp.prize_text),
      `Entry ${escapeHtml(formatUiString(comp.threshold_ui))} ${escapeHtml(symbol())}`,
      closed ? "Entries are closed. Hold is still being watched." : `Eligible in ${left}`,
      "",
    ];
    if (!rows.length) {
      lines.push("No entries yet. A wallet gets in when a buy leaves it at or above the entry size.");
      return lines.join("\n");
    }
    lines.push(`${rows.length} still in. The hold ends at the same time for every wallet.`, "");
    rows.forEach((row, index) => {
      const url = `https://solscan.io/account/${row.wallet}`;
      lines.push(
        `${index + 1}. <a href="${url}">${escapeHtml(shortAddress(row.wallet))}</a>`,
        `In the comp ${escapeHtml(formatTokenUi(Number(row.balance_raw) / 10 ** comp.decimals))} ${escapeHtml(symbol())}`,
        closed ? "Still holding" : `Eligible in ${left}`,
        "",
      );
    });
    return lines.join("\n").slice(0, 4000);
  }

  async function startCompetition({ thresholdUi, durationDays, prize, mediaType, mediaFileId }) {
    if (ctx.db.activeCompetition()) throw new Error("A competition is already running.");
    await ensureMeta();
    const dec = decimals();
    if (dec == null) {
      throw new Error("Token decimals are not loaded yet. Set the mint, check HELIUS_API_KEY, and try again in a few seconds.");
    }
    const thresholdRaw = uiStringToRaw(thresholdUi, dec);
    const startedAt = Date.now();
    const endsAt = startedAt + Math.round(durationDays * 86_400_000);
    const id = ctx.db.createCompetition({
      thresholdUi,
      thresholdRaw: thresholdRaw.toString(),
      decimals: dec,
      durationDays,
      prizeText: prize,
      startedAt,
      endsAt,
      mediaType: mediaType || "",
      mediaFileId: mediaFileId || "",
    });
    const created = ctx.db.competition(id);
    await announceCompetition(created);
    ctx.log.info("competition started", { id, thresholdUi, durationDays, card: Boolean(mediaFileId) });
    return ctx.db.competition(id);
  }

  async function endCompetitionNow() {
    const comp = ctx.db.activeCompetition();
    if (!comp) throw new Error("No active competition.");
    const endsAt = Date.now();
    ctx.db.setEndsAt(comp.id, endsAt);
    await refreshCompetitors();
    const fresh = ctx.db.competition(comp.id);
    const text = competitionReport(fresh, "Giveaway list");
    for (const part of chunkText(text)) await notify(part);
    ctx.db.markSummarySent(comp.id);
    return fresh;
  }

  function stopCompetition() {
    const comp = ctx.db.activeCompetition();
    if (!comp) throw new Error("No competition is running.");
    if (comp.status === "holding") throw new Error("Entries are already closed.");
    ctx.db.setCompetitionStatus(comp.id, "holding");
    ctx.log.info("competition entries closed", { id: comp.id });
    return ctx.db.competition(comp.id);
  }

  function cancelCompetition() {
    const comp = ctx.db.activeCompetition();
    if (!comp) throw new Error("No active competition.");
    ctx.db.setCompetitionStatus(comp.id, "cancelled");
    ctx.log.info("competition cancelled", { id: comp.id });
    return comp;
  }

  function describeCompetitors(kind) {
    const comp = ctx.db.activeCompetition() || ctx.db.recentCompetitions(1)[0];
    if (!comp) return "No competition yet.";
    const rows = ctx.db.competitors(comp.id, kind);
    if (!rows.length) return kind === "eligible" ? "No eligible wallets." : "No disqualified wallets.";
    const lines = rows.map((row) => {
      const held = row.entered_at ? formatDuration(Date.now() - row.entered_at) : "n/a";
      return [
        `<code>${escapeHtml(row.wallet)}</code>`,
        `Bought ${escapeHtml(formatRaw(row.total_bought_raw, comp.decimals))} · Still in comp ${escapeHtml(formatRaw(row.balance_raw, comp.decimals))}`,
        kind === "eligible" ? `Held ${held}` : `Out ${row.disqualified_at ? formatTimestamp(Math.floor(row.disqualified_at / 1000)) : ""}`,
      ].join("\n");
    });
    return lines.join("\n\n");
  }

  function start() {
    running = true;
    ctx.db.resetStuck();
    if (!ctx.db.getSetting("emoji_tiers") || ctx.db.getSetting("emoji_tiers") === OLD_TOKEN_TIERS) {
      ctx.db.setSetting("emoji_tiers", JSON.stringify(DEFAULT_TIERS));
    }
    if (!ctx.db.getSetting("emoji_mode")) ctx.db.setSetting("emoji_mode", "tiers");
    if (!ctx.db.getSetting("min_buy_ui")) ctx.db.setSetting("min_buy_ui", ctx.config.minBuy || "0");
    if (!ctx.db.getSetting("token_mint") && ctx.config.mint) ctx.db.setSetting("token_mint", ctx.config.mint);
    if (!ctx.db.getSetting("token_symbol") && ctx.config.symbol) ctx.db.setSetting("token_symbol", ctx.config.symbol);
    if (!ctx.db.getSetting("alert_chat_id") && ctx.config.alertChatId) {
      ctx.db.setSetting("alert_chat_id", ctx.config.alertChatId);
    }
    connectSocket();
    backfill();
    syncWebhook();
    const timers = [
      setInterval(() => backfill(), 20_000),
      setInterval(() => flushOutbox().catch((err) => ctx.log.error("outbox flush failed", { err })), 10_000),
      setInterval(() => refreshCompetitors().catch((err) => ctx.log.error("refresh failed", { err })), 45_000),
      setInterval(() => drainBalanceRetries().catch((err) => ctx.log.error("retry refresh failed", { err })), 20_000),
      setInterval(() => closeDueCompetitions().catch((err) => ctx.log.error("comp clock failed", { err })), 15_000),
      setInterval(() => syncWebhook(), 10 * 60_000),
    ];
    status.timers = timers;
  }

  function stop() {
    running = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    for (const timer of status.timers || []) clearInterval(timer);
    if (socket) socket.close();
  }

  return {
    start,
    stop,
    ingestEnhanced,
    ingestSignature,
    syncWebhook,
    resubscribe() {
      if (socket) socket.close();
      else connectSocket();
    },
    ensureMeta,
    startCompetition,
    endCompetitionNow,
    stopCompetition,
    cancelCompetition,
    competitionReport,
    describeCompetitors,
    leaderboardText,
    announceActive,
    symbol,
    mint,
    decimals,
    tiers,
    renderAlert,
  };
}
