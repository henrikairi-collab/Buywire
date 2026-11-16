import { escapeHtml, formatDuration, formatUiString, isMintAddress, parseDays, parseTokenAmount, parseUsd, shortAddress } from "./format.js";
import { ticketsForBuy } from "./lottery.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callTelegram(token, method, body, timeoutMs = 30_000, attempt = 0) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({}));
  if (!json.ok) {
    const retryAfter = json.parameters?.retry_after;
    if ((json.error_code === 429 || response.status === 429) && attempt < 4) {
      await sleep((Number(retryAfter) || 1) * 1000);
      return callTelegram(token, method, body, timeoutMs, attempt + 1);
    }
    const error = new Error(json.description || `Telegram ${method} failed`);
    error.code = json.error_code || response.status;
    error.migrateTo = json.parameters?.migrate_to_chat_id || null;
    throw error;
  }
  return json.result;
}

function validUrl(value) {
  const url = String(value || "").trim();
  if (!/^https:\/\/\S+$/i.test(url) || url.length > 300) return "";
  return url;
}

function parseTierLine(text) {
  const match = String(text).trim().replace(/[$,]/g, "").match(/^(\d+(?:\.\d{1,2})?)\s+(\d+)$/);
  if (!match) return null;
  const min = Number(match[1]);
  const bonus = Number(match[2]);
  if (!(min > 0) || bonus < 0 || bonus > 100000) return null;
  return { min, bonus };
}

function keyboard(rows) {
  return { inline_keyboard: rows };
}

function homeKeyboard() {
  return keyboard([
    [
      { text: "Settings", callback_data: "m:set" },
      { text: "Buy comp", callback_data: "m:comp" },
    ],
    [
      { text: "Lottery", callback_data: "m:lot" },
      { text: "Status", callback_data: "m:status" },
    ],
    [{ text: "Help", callback_data: "m:help" }],
  ]);
}

export function createTelegram(ctx) {
  const token = ctx.config.token;
  let polling = false;

  function tg(method, body, timeoutMs) {
    return callTelegram(token, method, body, timeoutMs);
  }

  function adminIds() {
    const fromEnv = ctx.config.adminIds;
    const saved = String(ctx.db.getSetting("admin_ids") || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return [...new Set([...fromEnv, ...saved])];
  }

  function isAdmin(userId) {
    return adminIds().includes(String(userId));
  }

  function claimOperator(userId) {
    if (isAdmin(userId)) return true;
    if (ctx.config.adminIds.length) return false;
    if (adminIds().length === 0) {
      ctx.db.setSetting("admin_ids", String(userId));
      return true;
    }
    return false;
  }

  async function sendText(chatId, text, replyMarkup) {
    return tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
      link_preview_options: { is_disabled: true },
    });
  }

  async function show(update, text, replyMarkup) {
    const query = update.callback_query;
    if (query) {
      await tg("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
      try {
        await tg("editMessageText", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
          link_preview_options: { is_disabled: true },
        });
        return;
      } catch (err) {
        if (String(err.message).includes("message is not modified")) return;
      }
      await sendText(query.message.chat.id, text, replyMarkup);
      return;
    }
    await sendText(update.message.chat.id, text, replyMarkup);
  }

  function tiersText() {
    let tiers = [];
    try {
      tiers = JSON.parse(ctx.db.getSetting("emoji_tiers") || "[]");
    } catch {
      tiers = [];
    }
    if (!tiers.length) return "No tiers yet.";
    return tiers
      .map((tier, index) => `${index + 1}. ${tier.emoji} at $${formatUiString(tier.min)}+`)
      .join("\n");
  }

  function settingsText() {
    const min = ctx.db.getSetting("min_buy_usd") || "0";
    const mode = ctx.db.getSetting("emoji_mode") || "tiers";
    const custom = ctx.db.getSetting("custom_emoji") || "none";
    const media = ctx.db.getSetting("media_type") || "none";
    const chat = ctx.db.getSetting("alert_chat_id");
    const mint = ctx.db.getSetting("token_mint") || "not set";
    const symbol = ctx.engine.symbol();
    const buy = ctx.db.getSetting("buy_url");
    const chart = ctx.db.getSetting("chart_url");
    return [
      "<b>Settings</b>",
      "",
      `Min buy: ${Number(min) > 0 ? `$${escapeHtml(min)}` : "every buy"}`,
      `Emoji: ${mode === "custom" ? `one symbol (${escapeHtml(custom)})` : "tiers, one per $10"}`,
      tiersText(),
      `Media: ${escapeHtml(media)}`,
      `Buy button: ${buy ? escapeHtml(buy) : "off"}`,
      `Chart button: ${chart ? escapeHtml(chart) : "off"}`,
      `Alert chat: ${chat ? `<code>${escapeHtml(chat)}</code>` : "not set — add the bot to the group and send /setchat"}`,
      `Mint: <code>${escapeHtml(mint)}</code>`,
      `Symbol: ${escapeHtml(symbol)}`,
    ].join("\n");
  }

  function settingsKeyboard() {
    return keyboard([
      [
        { text: "Min buy", callback_data: "s:min" },
        { text: "Tiers", callback_data: "s:tiers" },
      ],
      [
        { text: "One emoji", callback_data: "s:emoji" },
        { text: "Use tiers", callback_data: "s:usetiers" },
      ],
      [
        { text: "Attach media", callback_data: "s:media" },
        { text: "Clear media", callback_data: "s:clear" },
      ],
      [
        { text: "Set mint", callback_data: "s:mint" },
        { text: "Set symbol", callback_data: "s:sym" },
      ],
      [
        { text: "Buy link", callback_data: "s:buy" },
        { text: "Chart link", callback_data: "s:chart" },
      ],
      [{ text: "Add operator", callback_data: "s:ops" }],
      [{ text: "Back", callback_data: "m:home" }],
    ]);
  }

  function compText() {
    const comp = ctx.db.activeCompetition();
    if (!comp) return "<b>Buy comp</b>\n\nNo competition is running.";
    const eligible = ctx.db.competitors(comp.id, "eligible").length;
    const dq = ctx.db.competitors(comp.id, "disqualified").length;
    const left = formatDuration(comp.ends_at - Date.now());
    return [
      "<b>Buy comp</b>",
      "",
      `Prize: ${escapeHtml(comp.prize_text)}`,
      `Entry: $${escapeHtml(formatUiString(comp.threshold_ui))}`,
      `Hold: ${comp.duration_days} day(s)`,
      comp.status === "holding" ? "Entries: closed. Hold is still being watched." : `Time left: ${left}`,
      `Eligible: ${eligible}`,
      `Disqualified: ${dq}`,
      "",
      "A wallet enters when tokens bought after the start are worth at least the dollar entry. Tokens it already held do not count. Selling those new tokens back under the dollar line disqualifies it.",
      "",
      "/stopcomp closes entries. /endcomp draws the winner list. /cancelcomp aborts.",
    ].join("\n");
  }

  function compKeyboard() {
    const active = Boolean(ctx.db.activeCompetition());
    if (!active) {
      return keyboard([
        [{ text: "Start competition", callback_data: "c:start" }],
        [{ text: "Back", callback_data: "m:home" }],
      ]);
    }
    const holding = ctx.db.activeCompetition()?.status === "holding";
    return keyboard([
      [
        { text: "Eligible", callback_data: "c:elig" },
        { text: "Disqualified", callback_data: "c:dq" },
      ],
      holding
        ? [
            { text: "Draw winners", callback_data: "c:end" },
            { text: "Abort", callback_data: "c:cancel" },
          ]
        : [
            { text: "Close entries", callback_data: "c:stop" },
            { text: "Draw winners", callback_data: "c:end" },
          ],
      holding ? [] : [{ text: "Abort", callback_data: "c:cancel" }],
      [{ text: "Back", callback_data: "m:home" }],
    ].filter((row) => row.length));
  }

  function lotteryKeyboard() {
    const live = ctx.db.liveLottery();
    if (!live) {
      return keyboard([
        [{ text: "Start lottery", callback_data: "l:start" }],
        [{ text: "Back", callback_data: "m:home" }],
      ]);
    }
    if (live.status === "drawing") {
      return keyboard([
        [{ text: "Refresh", callback_data: "m:lot" }],
        [{ text: "Back", callback_data: "m:home" }],
      ]);
    }
    return keyboard([
      [
        { text: "Tickets", callback_data: "l:elig" },
        { text: "Burned", callback_data: "l:dq" },
      ],
      [
        { text: "Draw now", callback_data: "l:end" },
        { text: "Abort", callback_data: "l:cancel" },
      ],
      [{ text: "Back", callback_data: "m:home" }],
    ]);
  }

  function lotteryTierPreview(price, tiers) {
    if (!tiers?.length) return "No bonus tiers.";
    return tiers
      .map((tier) => {
        const sample = ticketsForBuy(tier.min, price, tiers);
        return `$${tier.min}+ adds ${tier.bonus} · a $${tier.min} buy earns ${sample.total}`;
      })
      .join("\n");
  }

  function lotteryConfirmText(draft) {
    const card = draft.mediaType ? draft.mediaType : "none";
    return [
      "<b>Start this lottery?</b>",
      `Ticket: $${escapeHtml(String(draft.ticketUsd))}`,
      `Length: ${draft.durationDays} day(s)`,
      `Prize: ${escapeHtml(draft.prize)}`,
      lotteryTierPreview(draft.ticketUsd, draft.tiers || []),
      `Card: ${escapeHtml(card)}`,
      "",
      "Only buys after the start count. Any sell burns that wallet's tickets.",
    ].join("\n");
  }

  function lotteryConfirmKeyboard() {
    return keyboard([
      [
        { text: "Start", callback_data: "lx:yes" },
        { text: "Cancel", callback_data: "lx:no" },
      ],
    ]);
  }

  function statusText() {
    const mint = ctx.engine.mint() || "not set";
    const lastTx = ctx.status.lastTxAt ? new Date(ctx.status.lastTxAt).toISOString() : "none yet";
    const lastAlert = ctx.status.lastAlertAt ? new Date(ctx.status.lastAlertAt).toISOString() : "none yet";
    const uptime = formatDuration(Date.now() - ctx.status.startedAt);
    const comp = ctx.db.activeCompetition();
    return [
      "<b>Buywire</b>",
      "",
      `Mint: <code>${escapeHtml(shortAddress(mint))}</code>`,
      `Stream: ${escapeHtml(ctx.status.stream)}`,
      `Webhook: ${escapeHtml(ctx.status.webhook)}`,
      `Last transaction: ${escapeHtml(lastTx)}`,
      `Last alert: ${escapeHtml(lastAlert)}`,
      `Uptime: ${uptime}`,
      comp ? `Competition #${comp.id} is active` : "No active competition",
    ].join("\n");
  }

  function helpText() {
    return [
      "<b>How Buywire watches</b>",
      "",
      "Every transaction that touches your mint is read three ways: a Helius webhook, a live websocket, and a signature backfill every 20 seconds. The same buy is only posted once.",
      "",
      "Alerts go to the chat where an operator sent /setchat. Buys under the minimum are ignored.",
      "",
      "Commands",
      "/start — this panel",
      "/settings — minimum, emoji, media, mint",
      "/comp — buy competition",
      "/buycomplb — entries and time left, including in the group",
      "/stopcomp — close entries, keep watching holders",
      "/endcomp — winner list with full addresses",
      "/cancelcomp — abort the competition",
      "/lottery — Trench Lottery",
      "/lotterylb — ticket list, including in the group",
      "/endlottery — draw the lottery now",
      "/cancellottery — abort the lottery",
      "/status — stream health",
      "/help — this note",
      "/setchat — use inside the alert group",
      "/cancel — abandon whatever you were typing",
    ].join("\n");
  }

  async function sendAlert(chatId, text) {
    const mediaType = ctx.db.getSetting("media_type");
    const fileId = ctx.db.getSetting("media_file_id");
    const map = { photo: ["sendPhoto", "photo"], animation: ["sendAnimation", "animation"], video: ["sendVideo", "video"] };
    const row = [];
    const buy = validUrl(ctx.db.getSetting("buy_url"));
    const chart = validUrl(ctx.db.getSetting("chart_url"));
    if (buy) row.push({ text: "Buy", url: buy });
    if (chart) row.push({ text: "Chart", url: chart });
    const reply_markup = row.length ? { inline_keyboard: [row] } : undefined;
    if (mediaType && fileId && map[mediaType]) {
      const [method, field] = map[mediaType];
      return tg(method, {
        chat_id: chatId,
        [field]: fileId,
        caption: text,
        parse_mode: "HTML",
        reply_markup,
      });
    }
    return sendText(chatId, text, reply_markup);
  }

  async function sendCard(chatId, text, mediaType, fileId) {
    const map = { photo: ["sendPhoto", "photo"], animation: ["sendAnimation", "animation"], video: ["sendVideo", "video"] };
    const caption = text.length > 1024 ? `${text.slice(0, 1000)}…` : text;
    if (mediaType && fileId && map[mediaType]) {
      const [method, field] = map[mediaType];
      return tg(method, {
        chat_id: chatId,
        [field]: fileId,
        caption,
        parse_mode: "HTML",
      });
    }
    return sendText(chatId, text);
  }

  async function editMessage(chatId, messageId, text) {
    return tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }

  async function pinMessage(chatId, messageId) {
    return tg("pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: false,
    });
  }

  function confirmText(draft) {
    const card = draft.mediaType ? draft.mediaType : "none";
    return [
      "<b>Start this competition?</b>",
      `Entry: $${escapeHtml(formatUiString(draft.thresholdUsd || draft.thresholdUi || "0"))}`,
      `Hold: ${draft.durationDays} day(s)`,
      `Prize: ${escapeHtml(draft.prize)}`,
      `Card: ${escapeHtml(card)}`,
    ].join("\n");
  }

  function confirmKeyboard() {
    return keyboard([
      [
        { text: "Start", callback_data: "x:yes" },
        { text: "Cancel", callback_data: "x:no" },
      ],
    ]);
  }

  async function notifyAdmins(text) {
    const ids = adminIds();
    if (!ids.length) {
      ctx.log.error("no operator to notify", { text });
      return;
    }
    for (const id of ids) {
      for (const part of text.length > 3500 ? [text.slice(0, 3500), text.slice(3500)] : [text]) {
        try {
          await sendText(id, part);
        } catch (err) {
          ctx.log.error("could not DM operator", { id, err });
        }
      }
    }
  }

  async function handleCallback(update) {
    const query = update.callback_query;
    const fromId = query.from.id;
    const data = query.data || "";
    if (!query.message || query.message.chat.type !== "private") {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Open a private chat for the panel." });
      return;
    }
    if (!isAdmin(fromId)) {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Operators only." });
      return;
    }
    if (data === "m:home") {
      ctx.db.clearSession(fromId);
      await show(update, homeText(true), homeKeyboard());
      return;
    }
    if (data === "m:set") return show(update, settingsText(), settingsKeyboard());
    if (data === "m:help") return show(update, helpText(), keyboard([[{ text: "Back", callback_data: "m:home" }]]));
    if (data === "m:status") return show(update, statusText(), keyboard([[{ text: "Back", callback_data: "m:home" }]]));
    if (data === "m:comp") return show(update, compText(), compKeyboard());
    if (data === "m:lot") return show(update, ctx.engine.lotteryStatusText(), lotteryKeyboard());
    if (data === "s:min") {
      ctx.db.setSession(fromId, "min");
      return show(update, "Send the minimum buy in US dollars. Example: <code>10</code> or <code>25.50</code>. Buys under that are ignored. Send <code>0</code> to post every buy.", keyboard([[{ text: "Back", callback_data: "m:set" }]]));
    }
    if (data === "s:tiers") {
      ctx.db.setSession(fromId, "tier");
      return show(
        update,
        `Current tiers:\n${tiersText()}\n\nTiers pick the emoji. The number is US dollars. One emoji is added for every $10. Send <code>50 🔥</code> to set a tier. Send <code>clear 50</code> to remove it.`,
        keyboard([[{ text: "Back", callback_data: "m:set" }]]),
      );
    }
    if (data === "s:emoji") {
      ctx.db.setSession(fromId, "emoji");
      return show(update, "Send one emoji. Every alert at or above the minimum will use it instead of the tiers.", keyboard([[{ text: "Back", callback_data: "m:set" }]]));
    }
    if (data === "s:usetiers") {
      ctx.db.setSetting("emoji_mode", "tiers");
      ctx.db.clearSession(fromId);
      return show(update, settingsText(), settingsKeyboard());
    }
    if (data === "s:media") {
      ctx.db.setSession(fromId, "media");
      return show(update, "Send a photo, a GIF, or a video. It will be attached to every buy alert.", keyboard([[{ text: "Back", callback_data: "m:set" }]]));
    }
    if (data === "s:clear") {
      ctx.db.setSetting("media_type", "");
      ctx.db.setSetting("media_file_id", "");
      return show(update, settingsText(), settingsKeyboard());
    }
    if (data === "s:chart") {
      ctx.db.setSession(fromId, "charturl");
      return show(update, "Send the chart link, starting with https://. It becomes the Chart button on buy alerts. Send <code>off</code> to remove it.", keyboard([[{ text: "Back", callback_data: "m:set" }]]));
    }
    if (data === "s:buy") {
      ctx.db.setSession(fromId, "buyurl");
      return show(update, "Send the buy link, starting with https://. It becomes the Buy button on buy alerts. Send <code>off</code> to remove it.", keyboard([[{ text: "Back", callback_data: "m:set" }]]));
    }
    if (data === "s:mint") {
      ctx.db.setSession(fromId, "mint");
      return show(update, "Send the token mint address.", keyboard([[{ text: "Back", callback_data: "m:set" }]]));
    }
    if (data === "s:sym") {
      ctx.db.setSession(fromId, "symbol");
      return show(update, "Send the ticker to show in alerts, for example <code>WIRE</code>.", keyboard([[{ text: "Back", callback_data: "m:set" }]]));
    }
    if (data === "s:ops") {
      ctx.db.setSession(fromId, "admin");
      return show(update, "Send the Telegram numeric user id to add as an operator.", keyboard([[{ text: "Back", callback_data: "m:set" }]]));
    }
    if (data === "c:start") {
      ctx.db.setSession(fromId, "comp_threshold", {});
      return show(update, "Entry in US dollars of tokens bought after the start. Example: <code>20</code> means every wallet that buys at least $20 and holds it.", keyboard([[{ text: "Back", callback_data: "m:comp" }]]));
    }
    if (data === "c:elig" || data === "c:dq") {
      const kind = data === "c:elig" ? "eligible" : "disqualified";
      const body = ctx.engine.describeCompetitors(kind);
      return show(update, `<b>${kind === "eligible" ? "Eligible" : "Disqualified"}</b>\n\n${body}`, compKeyboard());
    }
    if (data === "c:end") {
      try {
        await ctx.engine.endCompetitionNow();
        return show(update, "Winner list sent in this chat. Full addresses are in that message.", compKeyboard());
      } catch (err) {
        return show(update, escapeHtml(err.message), compKeyboard());
      }
    }
    if (data === "c:stop") {
      try {
        ctx.engine.stopCompetition();
        return show(update, "Entries are closed. Current wallets are still watched. Sell under the line and they are out. Send /endcomp when you want the winner list.", compKeyboard());
      } catch (err) {
        return show(update, escapeHtml(err.message), compKeyboard());
      }
    }
    if (data === "c:cancel") {
      try {
        ctx.engine.cancelCompetition();
        return show(update, "Competition aborted. No winner list was sent.", compKeyboard());
      } catch (err) {
        return show(update, escapeHtml(err.message), compKeyboard());
      }
    }
    if (data.startsWith("d:")) {
      const session = ctx.db.session(fromId);
      if (data === "d:custom") {
        ctx.db.setSession(fromId, "comp_days", session.data || {});
        return show(update, "How many days should the hold last? Any positive number, for example <code>12</code> or <code>0.5</code>.", keyboard([[{ text: "Back", callback_data: "m:comp" }]]));
      }
      const days = Number(data.slice(2));
      const draft = { ...(session.data || {}), durationDays: days };
      ctx.db.setSession(fromId, "comp_prize", draft);
      return show(update, `Hold is ${days} day(s).\n\nSend the prize as text. Example: <code>$25 of SOL</code>. This is a label, not a payment.`, keyboard([[{ text: "Back", callback_data: "m:comp" }]]));
    }
    if (data === "c:skipmedia") {
      const draft = { ...(ctx.db.session(fromId).data || {}) };
      delete draft.mediaType;
      delete draft.mediaFileId;
      ctx.db.setSession(fromId, "comp_confirm", draft);
      return show(update, confirmText(draft), confirmKeyboard());
    }
    if (data === "x:yes") {
      const draft = ctx.db.session(fromId).data || {};
      try {
        const comp = await ctx.engine.startCompetition({
          thresholdUsd: draft.thresholdUsd || draft.thresholdUi,
          durationDays: draft.durationDays,
          prize: draft.prize,
          mediaType: draft.mediaType || "",
          mediaFileId: draft.mediaFileId || "",
        });
        ctx.db.clearSession(fromId);
        const posted = Boolean(comp.announced);
        return show(
          update,
          posted
            ? `Competition #${comp.id} is live. The card is in the alert group.`
            : `Competition #${comp.id} is live, but no alert group is set. Add the bot to the group and send /setchat there. The card will post then.`,
          compKeyboard(),
        );
      } catch (err) {
        return show(update, escapeHtml(err.message), keyboard([[{ text: "Back", callback_data: "m:comp" }]]));
      }
    }
    if (data === "x:no") {
      ctx.db.clearSession(fromId);
      return show(update, compText(), compKeyboard());
    }
    if (data === "l:start") {
      ctx.db.setSession(fromId, "lot_price", {});
      return show(update, "Ticket price in US dollars. A $50 buy at <code>25</code> earns 2 tickets. A $76 buy earns 3.", keyboard([[{ text: "Back", callback_data: "m:lot" }]]));
    }
    if (data === "l:elig" || data === "l:dq") {
      const kind = data === "l:elig" ? "eligible" : "disqualified";
      return show(update, ctx.engine.describeLottery(kind), lotteryKeyboard());
    }
    if (data === "l:end") {
      try {
        await ctx.engine.endLotteryNow();
        return show(update, "The draw is spinning in the alert group. It takes five minutes.", lotteryKeyboard());
      } catch (err) {
        return show(update, escapeHtml(err.message), lotteryKeyboard());
      }
    }
    if (data === "l:cancel") {
      try {
        ctx.engine.cancelLottery();
        return show(update, "Lottery aborted. No draw.", lotteryKeyboard());
      } catch (err) {
        return show(update, escapeHtml(err.message), lotteryKeyboard());
      }
    }
    if (data.startsWith("ld:")) {
      const session = ctx.db.session(fromId);
      if (data === "ld:custom") {
        ctx.db.setSession(fromId, "lot_days", session.data || {});
        return show(update, "How many days should the lottery run? Example: <code>12</code> or <code>0.5</code>.", keyboard([[{ text: "Back", callback_data: "m:lot" }]]));
      }
      const days = Number(data.slice(3));
      const draft = { ...(session.data || {}), durationDays: days, tiers: [] };
      ctx.db.setSession(fromId, "lot_tiers", draft);
      return show(update, lotteryTierPrompt(draft), keyboard([[{ text: "No bonus tiers", callback_data: "l:notiers" }]]));
    }
    if (data === "l:notiers") {
      const draft = { ...(ctx.db.session(fromId).data || {}), tiers: [] };
      ctx.db.setSession(fromId, "lot_prize", draft);
      return show(update, "Prize text. Example: <code>$25 of SOL</code>. This is a label, not a payment.", keyboard([[{ text: "Back", callback_data: "m:lot" }]]));
    }
    if (data === "l:skipmedia") {
      const draft = { ...(ctx.db.session(fromId).data || {}) };
      delete draft.mediaType;
      delete draft.mediaFileId;
      ctx.db.setSession(fromId, "lot_confirm", draft);
      return show(update, lotteryConfirmText(draft), lotteryConfirmKeyboard());
    }
    if (data === "lx:yes") {
      const draft = ctx.db.session(fromId).data || {};
      try {
        const lot = await ctx.engine.startLottery({
          ticketUsd: draft.ticketUsd,
          durationDays: draft.durationDays,
          prize: draft.prize,
          tiers: draft.tiers || [],
          mediaType: draft.mediaType || "",
          mediaFileId: draft.mediaFileId || "",
        });
        ctx.db.clearSession(fromId);
        return show(update, `Trench Lottery #${lot.id} is live. Only buys from now on count. Any sell burns that wallet.`, lotteryKeyboard());
      } catch (err) {
        return show(update, escapeHtml(err.message), lotteryKeyboard());
      }
    }
    if (data === "lx:no") {
      ctx.db.clearSession(fromId);
      return show(update, ctx.engine.lotteryStatusText(), lotteryKeyboard());
    }
    await tg("answerCallbackQuery", { callback_query_id: query.id });
  }

  function lotteryTierPrompt(draft) {
    return [
      `Ticket is $${draft.ticketUsd}. ${draft.durationDays} day(s).`,
      "",
      "Bonus tiers stack on top of the base tickets. Highest match wins.",
      "Send <code>100 1</code> if a $100 buy should get its 4 base tickets plus 1 bonus.",
      "Send <code>500 10</code> if a $500 buy should get 20 base plus 10, which is 30.",
      "Send <code>done</code> when the list is finished.",
      "",
      lotteryTierPreview(draft.ticketUsd, draft.tiers || []),
    ].join("\n");
  }

  function homeText(isOperator) {
    if (!isOperator) {
      return "Buywire posts DEX buys for one Solana mint.\n\nThis control panel belongs to the operator.";
    }
    const mint = ctx.engine.mint();
    return [
      "<b>Buywire</b>",
      mint ? `Watching <code>${escapeHtml(shortAddress(mint))}</code>` : "No mint set yet. Open Settings.",
      "",
      "Buy alerts, the hold competition, and Trench Lottery live here.",
    ].join("\n");
  }

  async function handleText(message) {
    const fromId = message.from.id;
    const chat = message.chat;
    const text = (message.text || "").trim();
    const command = text.split(/\s/)[0].split("@")[0].toLowerCase();

    if (command === "/setchat") {
      if (!isAdmin(fromId)) {
        await sendText(chat.id, "Operators only. Open a private chat and send /start first.");
        return;
      }
      ctx.db.setSetting("alert_chat_id", String(chat.id));
      ctx.log.info("alert chat set", { chatId: chat.id });
      const posted = await ctx.engine.announceActive();
      await sendText(
        chat.id,
        posted
          ? `Buy alerts will post here.\n<code>${chat.id}</code>\n\nThe buy comp card is in this chat.`
          : `Buy alerts will post here.\n<code>${chat.id}</code>`,
      );
      return;
    }

    if (command === "/buycomplb") {
      await sendText(chat.id, ctx.engine.leaderboardText());
      return;
    }
    if (command === "/lotterylb") {
      await sendText(chat.id, ctx.engine.lotteryBoard());
      return;
    }

    if (command === "/stopcomp" || command === "/endcomp" || command === "/cancelcomp" || command === "/endlottery" || command === "/cancellottery") {
      if (chat.type !== "private") {
        await sendText(chat.id, "Send that in a private chat with me. The winner list is not posted here.");
        return;
      }
      if (!isAdmin(fromId)) {
        await sendText(chat.id, "Operators only. Send /start first.");
        return;
      }
      try {
        if (command === "/stopcomp") {
          ctx.engine.stopCompetition();
          await sendText(chat.id, "Entries are closed. Everyone already in is still watched. A sell under the entry size disqualifies them. Send /endcomp when you want the winner list.");
          return;
        }
        if (command === "/cancelcomp") {
          ctx.engine.cancelCompetition();
          await sendText(chat.id, "Competition aborted. No winner list was sent.");
          return;
        }
        if (command === "/cancellottery") {
          ctx.engine.cancelLottery();
          await sendText(chat.id, "Lottery aborted. No draw.");
          return;
        }
        if (command === "/endlottery") {
          await ctx.engine.endLotteryNow();
          await sendText(chat.id, "The draw is spinning in the alert group. It takes five minutes.");
          return;
        }
        await ctx.engine.endCompetitionNow();
        await sendText(chat.id, "Winner list is above. Those are the full addresses still eligible.");
      } catch (err) {
        await sendText(chat.id, escapeHtml(err.message));
      }
      return;
    }

    if (chat.type !== "private") {
      if (command === "/start" || command === "/help") {
        await sendText(chat.id, "DM me for the control panel. In this chat, an operator can send /setchat to publish buys here.");
      }
      return;
    }

    if (command === "/start") {
      const operator = claimOperator(fromId);
      ctx.db.clearSession(fromId);
      await sendText(chat.id, homeText(operator), operator ? homeKeyboard() : undefined);
      return;
    }
    if (command === "/help") {
      await sendText(chat.id, helpText(), keyboard([[{ text: "Menu", callback_data: "m:home" }]]));
      return;
    }
    if (command === "/cancel") {
      ctx.db.clearSession(fromId);
      await sendText(chat.id, "Cancelled.", homeKeyboard());
      return;
    }
    if (!isAdmin(fromId)) {
      await sendText(chat.id, homeText(false));
      return;
    }
    if (command === "/settings") return sendText(chat.id, settingsText(), settingsKeyboard());
    if (command === "/comp") return sendText(chat.id, compText(), compKeyboard());
    if (command === "/lottery") return sendText(chat.id, ctx.engine.lotteryStatusText(), lotteryKeyboard());
    if (command === "/buycomplb") return sendText(chat.id, ctx.engine.leaderboardText());
    if (command === "/status") return sendText(chat.id, statusText(), keyboard([[{ text: "Menu", callback_data: "m:home" }]]));

    const session = ctx.db.session(fromId);
    if (session.state === "idle") {
      await sendText(chat.id, homeText(true), homeKeyboard());
      return;
    }
    if (session.state === "min") {
      const amount = parseUsd(text);
      if (amount == null) {
        await sendText(chat.id, "Send a dollar amount like <code>10</code> or <code>25.50</code>.");
        return;
      }
      ctx.db.setSetting("min_buy_usd", amount);
      ctx.db.clearSession(fromId);
      await sendText(chat.id, settingsText(), settingsKeyboard());
      return;
    }
    if (session.state === "buyurl" || session.state === "charturl") {
      const key = session.state === "buyurl" ? "buy_url" : "chart_url";
      if (/^off$/i.test(text)) {
        ctx.db.setSetting(key, "");
        ctx.db.clearSession(fromId);
        await sendText(chat.id, settingsText(), settingsKeyboard());
        return;
      }
      const url = validUrl(text);
      if (!url) {
        await sendText(chat.id, "Send a link that starts with https://, or <code>off</code>.");
        return;
      }
      ctx.db.setSetting(key, url);
      ctx.db.clearSession(fromId);
      await sendText(chat.id, settingsText(), settingsKeyboard());
      return;
    }
    if (session.state === "emoji") {
      if (!text || text.length > 16) {
        await sendText(chat.id, "Send a short emoji.");
        return;
      }
      ctx.db.setSetting("custom_emoji", text);
      ctx.db.setSetting("emoji_mode", "custom");
      ctx.db.clearSession(fromId);
      await sendText(chat.id, settingsText(), settingsKeyboard());
      return;
    }
    if (session.state === "tier") {
      let tiers = [];
      try {
        tiers = JSON.parse(ctx.db.getSetting("emoji_tiers") || "[]");
      } catch {
        tiers = [];
      }
      if (text.toLowerCase().startsWith("clear ")) {
        const amount = parseTokenAmount(text.slice(6));
        if (!amount) {
          await sendText(chat.id, "Usage: <code>clear 10000</code>");
          return;
        }
        tiers = tiers.filter((tier) => String(tier.min) !== amount);
      } else {
        const match = text.match(/^(\S+)\s+(\S+)$/);
        if (!match) {
          await sendText(chat.id, "Usage: <code>10000 🔥</code>");
          return;
        }
        const amount = parseTokenAmount(match[1]);
        if (!amount) {
          await sendText(chat.id, "I could not read that minimum.");
          return;
        }
        tiers = tiers.filter((tier) => String(tier.min) !== amount);
        tiers.push({ min: amount, emoji: match[2] });
        tiers.sort((a, b) => Number(a.min) - Number(b.min));
      }
      ctx.db.setSetting("emoji_tiers", JSON.stringify(tiers));
      ctx.db.setSetting("emoji_mode", "tiers");
      ctx.db.clearSession(fromId);
      await sendText(chat.id, settingsText(), settingsKeyboard());
      return;
    }
    if (session.state === "mint") {
      if (!isMintAddress(text)) {
        await sendText(chat.id, "That does not look like a Solana mint.");
        return;
      }
      ctx.db.setSetting("token_mint", text);
      ctx.db.setSetting("token_decimals", "");
      ctx.db.setSetting("token_symbol", "");
      ctx.db.setSetting(`bootstrapped:${text}`, "0");
      ctx.db.clearSession(fromId);
      ctx.engine.resubscribe();
      ctx.engine.syncWebhook();
      ctx.engine.ensureMeta().catch((err) => ctx.log.warn("meta refresh failed", { err }));
      await sendText(chat.id, "Mint saved. History before this moment will not be replayed. New buys will.", settingsKeyboard());
      return;
    }
    if (session.state === "symbol") {
      const symbol = text.replace(/\s+/g, "").slice(0, 16);
      if (!symbol) {
        await sendText(chat.id, "Send a ticker.");
        return;
      }
      ctx.db.setSetting("token_symbol", symbol);
      ctx.db.clearSession(fromId);
      await sendText(chat.id, settingsText(), settingsKeyboard());
      return;
    }
    if (session.state === "admin") {
      if (!/^\d{5,20}$/.test(text)) {
        await sendText(chat.id, "Send a numeric Telegram user id.");
        return;
      }
      const ids = new Set(adminIds());
      ids.add(text);
      ctx.db.setSetting("admin_ids", [...ids].join(","));
      ctx.db.clearSession(fromId);
      await sendText(chat.id, `Operator ${text} added.`, settingsKeyboard());
      return;
    }
    if (session.state === "lot_price") {
      const price = parseUsd(text);
      if (!price || Number(price) <= 0) {
        await sendText(chat.id, "Send a dollar amount like <code>25</code>.");
        return;
      }
      ctx.db.setSession(fromId, "lot_duration", { ticketUsd: price });
      await sendText(
        chat.id,
        "How long does the lottery run? Everyone shares this countdown.",
        keyboard([
          [
            { text: "1 day", callback_data: "ld:1" },
            { text: "3 days", callback_data: "ld:3" },
            { text: "1 week", callback_data: "ld:7" },
          ],
          [
            { text: "15 days", callback_data: "ld:15" },
            { text: "30 days", callback_data: "ld:30" },
          ],
          [{ text: "Custom days", callback_data: "ld:custom" }],
        ]),
      );
      return;
    }
    if (session.state === "lot_days") {
      const days = parseDays(text);
      if (!days) {
        await sendText(chat.id, "Send a positive number of days, up to 3650.");
        return;
      }
      const draft = { ...(session.data || {}), durationDays: days, tiers: [] };
      ctx.db.setSession(fromId, "lot_tiers", draft);
      await sendText(chat.id, lotteryTierPrompt(draft), keyboard([[{ text: "No bonus tiers", callback_data: "l:notiers" }]]));
      return;
    }
    if (session.state === "lot_tiers") {
      if (/^done$/i.test(text)) {
        const draft = session.data || {};
        ctx.db.setSession(fromId, "lot_prize", draft);
        await sendText(chat.id, "Prize text. Example: <code>$25 of SOL</code>. This is a label, not a payment.");
        return;
      }
      const tier = parseTierLine(text);
      if (!tier) {
        await sendText(chat.id, "Send <code>100 1</code>, or <code>done</code>.");
        return;
      }
      const tiers = [...(session.data?.tiers || []).filter((row) => Number(row.min) !== tier.min), tier].sort(
        (a, b) => a.min - b.min,
      );
      const draft = { ...(session.data || {}), tiers };
      ctx.db.setSession(fromId, "lot_tiers", draft);
      await sendText(chat.id, lotteryTierPrompt(draft));
      return;
    }
    if (session.state === "lot_prize") {
      if (!text || text.length > 300) {
        await sendText(chat.id, "Send a short prize description.");
        return;
      }
      const draft = { ...(session.data || {}), prize: text };
      ctx.db.setSession(fromId, "lot_media", draft);
      await sendText(
        chat.id,
        "Send a photo, GIF, or video for the lottery announcement in the group.",
        keyboard([[{ text: "Skip media", callback_data: "l:skipmedia" }]]),
      );
      return;
    }
    if (session.state === "lot_media") {
      await sendText(chat.id, "Send a photo, GIF, or video, or tap Skip media.");
      return;
    }
    if (session.state === "comp_threshold") {
      const amount = parseUsd(text);
      if (!amount || Number(amount) <= 0) {
        await sendText(chat.id, "Send a dollar amount like <code>20</code>.");
        return;
      }
      ctx.db.setSession(fromId, "comp_duration", { thresholdUsd: amount });
      await sendText(
        chat.id,
        "How long do they have to hold those tokens?",
        keyboard([
          [
            { text: "1 day", callback_data: "d:1" },
            { text: "3 days", callback_data: "d:3" },
            { text: "1 week", callback_data: "d:7" },
          ],
          [
            { text: "15 days", callback_data: "d:15" },
            { text: "30 days", callback_data: "d:30" },
          ],
          [{ text: "Custom days", callback_data: "d:custom" }],
        ]),
      );
      return;
    }
    if (session.state === "comp_days") {
      const days = parseDays(text);
      if (!days) {
        await sendText(chat.id, "Send a positive number of days, up to 3650.");
        return;
      }
      const draft = { ...(session.data || {}), durationDays: days };
      ctx.db.setSession(fromId, "comp_prize", draft);
      await sendText(chat.id, "Prize description. Example: <code>$25 of SOL</code> or <code>500 USDC</code>. Buywire does not send the prize.");
      return;
    }
    if (session.state === "comp_prize") {
      if (!text || text.length > 300) {
        await sendText(chat.id, "Send a short prize description.");
        return;
      }
      const draft = { ...(session.data || {}), prize: text };
      ctx.db.setSession(fromId, "comp_media", draft);
      await sendText(
        chat.id,
        "Send a photo, GIF, or video. That file is the card posted in the group when the comp starts.",
        keyboard([[{ text: "Skip media", callback_data: "c:skipmedia" }]]),
      );
      return;
    }
    if (session.state === "comp_media") {
      await sendText(chat.id, "Send a photo, GIF, or video, or tap Skip media.");
    }
  }

  async function handleMedia(message) {
    if (message.chat.type !== "private" || !isAdmin(message.from.id)) return;
    const session = ctx.db.session(message.from.id);
    let type = null;
    let fileId = null;
    if (message.photo?.length) {
      type = "photo";
      fileId = message.photo[message.photo.length - 1].file_id;
    } else if (message.animation) {
      type = "animation";
      fileId = message.animation.file_id;
    } else if (message.video) {
      type = "video";
      fileId = message.video.file_id;
    }
    if (!type || !fileId) return;
    if (session.state === "comp_media") {
      const draft = { ...(session.data || {}), mediaType: type, mediaFileId: fileId };
      ctx.db.setSession(message.from.id, "comp_confirm", draft);
      await sendText(message.chat.id, confirmText(draft), confirmKeyboard());
      return;
    }
    if (session.state === "lot_media") {
      const draft = { ...(session.data || {}), mediaType: type, mediaFileId: fileId };
      ctx.db.setSession(message.from.id, "lot_confirm", draft);
      await sendText(message.chat.id, lotteryConfirmText(draft), lotteryConfirmKeyboard());
      return;
    }
    if (session.state !== "media") return;
    ctx.db.setSetting("media_type", type);
    ctx.db.setSetting("media_file_id", fileId);
    ctx.db.clearSession(message.from.id);
    await sendText(message.chat.id, `Attached a ${type} to future buy alerts.`, settingsKeyboard());
  }

  async function handleUpdate(update) {
    try {
      if (update.callback_query) {
        await handleCallback(update);
        return;
      }
      const message = update.message;
      if (!message) return;
      if (message.photo || message.animation || message.video) {
        await handleMedia(message);
        return;
      }
      if (typeof message.text === "string") await handleText(message);
    } catch (err) {
      ctx.log.error("telegram update failed", { err });
    }
  }

  async function poll() {
    let offset = 0;
    let delay = 1000;
    while (polling) {
      try {
        const updates = await tg(
          "getUpdates",
          {
            offset,
            timeout: 50,
            allowed_updates: ["message", "callback_query", "my_chat_member"],
          },
          70_000,
        );
        delay = 1000;
        for (const update of updates) {
          offset = update.update_id + 1;
          await handleUpdate(update);
        }
      } catch (err) {
        ctx.log.error("getUpdates failed", { err });
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  return {
    sendAlert,
    sendCard,
    editMessage,
    pinMessage,
    notifyAdmins,
    async start() {
      if (!token) {
        ctx.log.error("TELEGRAM_BOT_TOKEN is missing. The HTTP health check stays up; Telegram is off.");
        ctx.status.telegram = "missing-token";
        return;
      }
      try {
        const me = await tg("getMe", {});
        ctx.status.telegram = me.username ? `@${me.username}` : "connected";
        ctx.log.info("telegram connected", { username: me.username });
        await tg("setMyCommands", {
          commands: [
            { command: "start", description: "Open the control panel" },
            { command: "settings", description: "Minimum, emoji, media, mint" },
            { command: "comp", description: "Buy competition" },
            { command: "buycomplb", description: "Entries and time left" },
            { command: "stopcomp", description: "Close entries, keep watching" },
            { command: "endcomp", description: "Winner list with full addresses" },
            { command: "cancelcomp", description: "Abort the competition" },
            { command: "lottery", description: "Trench Lottery" },
            { command: "lotterylb", description: "Lottery ticket list" },
            { command: "endlottery", description: "Draw the lottery now" },
            { command: "cancellottery", description: "Abort the lottery" },
            { command: "status", description: "Stream health" },
            { command: "help", description: "How Buywire works" },
            { command: "setchat", description: "Post alerts in this chat" },
            { command: "cancel", description: "Stop the current prompt" },
          ],
        }).catch((err) => ctx.log.warn("setMyCommands failed", { err }));
        await tg("setMyCommands", {
          scope: { type: "all_group_chats" },
          commands: [
            { command: "buycomplb", description: "Entries and time left" },
            { command: "lotterylb", description: "Lottery ticket list" },
            { command: "setchat", description: "Post alerts in this chat" },
          ],
        }).catch((err) => ctx.log.warn("setMyCommands group scope failed", { err }));
      } catch (err) {
        ctx.status.telegram = "error";
        ctx.log.error("telegram getMe failed; will keep retrying polls", { err });
      }
      polling = true;
      poll();
    },
    stop() {
      polling = false;
    },
  };
}
