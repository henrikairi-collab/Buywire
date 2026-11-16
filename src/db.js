import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen (
  signature TEXT PRIMARY KEY,
  effects INTEGER NOT NULL DEFAULT 0,
  alert TEXT,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS buy_events (
  signature TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  PRIMARY KEY (signature, wallet)
);
CREATE TABLE IF NOT EXISTS alerts (
  signature TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  amount_ui REAL NOT NULL,
  usd REAL,
  dex TEXT,
  ts INTEGER NOT NULL,
  chat_id TEXT,
  message_id INTEGER
);
CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  threshold_ui TEXT NOT NULL,
  threshold_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  duration_days REAL NOT NULL,
  prize_text TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary_sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS competitors (
  competition_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  entered_at INTEGER,
  total_bought_raw TEXT NOT NULL DEFAULT '0',
  balance_raw TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL,
  disqualified_at INTEGER,
  PRIMARY KEY (competition_id, wallet)
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  signature TEXT NOT NULL,
  wallet TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (signature, wallet)
);
CREATE TABLE IF NOT EXISTS lottery_buys (
  signature TEXT NOT NULL,
  wallet TEXT NOT NULL,
  lottery_id INTEGER NOT NULL,
  PRIMARY KEY (signature, wallet)
);
CREATE TABLE IF NOT EXISTS lotteries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_usd REAL NOT NULL,
  tiers_json TEXT NOT NULL,
  duration_days REAL NOT NULL,
  prize_text TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  winner TEXT,
  draw_chat_id TEXT,
  draw_message_id INTEGER,
  draw_started_at INTEGER
);
CREATE TABLE IF NOT EXISTS lottery_wallets (
  lottery_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  tickets INTEGER NOT NULL DEFAULT 0,
  tickets_earned INTEGER NOT NULL DEFAULT 0,
  usd_spent REAL NOT NULL DEFAULT 0,
  net_raw TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL,
  disqualified_at INTEGER,
  PRIMARY KEY (lottery_id, wallet)
);
`;

export function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  for (const [name, type] of [
    ["media_type", "TEXT"],
    ["media_file_id", "TEXT"],
    ["announced", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    const cols = db.prepare("PRAGMA table_info(competitions)").all();
    if (!cols.some((col) => col.name === name)) {
      db.exec(`ALTER TABLE competitions ADD COLUMN ${name} ${type}`);
    }
  }
  const competitorCols = db.prepare("PRAGMA table_info(competitors)").all();
  if (!competitorCols.some((col) => col.name === "sold_raw")) {
    db.exec("ALTER TABLE competitors ADD COLUMN sold_raw TEXT NOT NULL DEFAULT '0'");
  }

  const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const setSettingStmt = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  return {
    filePath,
    close() {
      db.close();
    },
    getSetting(key, fallback = null) {
      const row = getSettingStmt.get(key);
      return row ? row.value : fallback;
    },
    setSetting(key, value) {
      setSettingStmt.run(key, String(value));
    },
    /** @returns {boolean} true when this process owns the signature */
    claim(signature) {
      const now = Date.now();
      const result = db
        .prepare(
          "INSERT INTO seen(signature, effects, alert, seen_at) VALUES (?, 0, NULL, ?) ON CONFLICT(signature) DO NOTHING",
        )
        .run(signature, now);
      return result.changes === 1;
    },
    seen(signature) {
      return db.prepare("SELECT signature, effects, alert FROM seen WHERE signature = ?").get(signature) || null;
    },
    markEffects(signature) {
      db.prepare("UPDATE seen SET effects = 1 WHERE signature = ?").run(signature);
    },
    setAlertFlag(signature, flag) {
      db.prepare("UPDATE seen SET alert = ? WHERE signature = ?").run(flag, signature);
    },
    release(signature) {
      db.prepare("DELETE FROM seen WHERE signature = ? AND effects = 0").run(signature);
    },
    resetStuck() {
      db.prepare("DELETE FROM seen WHERE effects = 0").run();
    },
    recordBuy(signature, wallet, amountRaw) {
      const result = db
        .prepare(
          "INSERT INTO buy_events(signature, wallet, amount_raw) VALUES (?, ?, ?) ON CONFLICT(signature, wallet) DO NOTHING",
        )
        .run(signature, wallet, amountRaw);
      return result.changes === 1;
    },
    hasBuy(signature, wallet) {
      return Boolean(
        db.prepare("SELECT 1 AS ok FROM buy_events WHERE signature = ? AND wallet = ?").get(signature, wallet),
      );
    },
    recordAlert(row) {
      db.prepare(
        `INSERT INTO alerts(signature, wallet, amount_ui, usd, dex, ts, chat_id, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(signature) DO UPDATE SET
           message_id = excluded.message_id,
           chat_id = excluded.chat_id`,
      ).run(
        row.signature,
        row.wallet,
        row.amountUi,
        row.usd,
        row.dex,
        row.ts,
        row.chatId,
        row.messageId,
      );
    },
    activeCompetition() {
      return (
        db.prepare(
          "SELECT * FROM competitions WHERE status IN ('active', 'holding') ORDER BY id DESC LIMIT 1",
        ).get() || null
      );
    },
    competition(id) {
      return db.prepare("SELECT * FROM competitions WHERE id = ?").get(id) || null;
    },
    recentCompetitions(limit = 5) {
      return db
        .prepare("SELECT * FROM competitions ORDER BY id DESC LIMIT ?")
        .all(limit);
    },
    createCompetition(row) {
      const result = db
        .prepare(
          `INSERT INTO competitions(threshold_ui, threshold_raw, decimals, duration_days, prize_text, started_at, ends_at, status, media_type, media_file_id, announced)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0)`,
        )
        .run(
          row.thresholdUi,
          row.thresholdRaw,
          row.decimals,
          row.durationDays,
          row.prizeText,
          row.startedAt,
          row.endsAt,
          row.mediaType || null,
          row.mediaFileId || null,
        );
      return Number(result.lastInsertRowid);
    },
    setCompetitionStatus(id, status) {
      db.prepare("UPDATE competitions SET status = ? WHERE id = ?").run(status, id);
    },
    setEndsAt(id, endsAt) {
      db.prepare("UPDATE competitions SET ends_at = ? WHERE id = ?").run(endsAt, id);
    },
    markSummarySent(id) {
      db.prepare("UPDATE competitions SET summary_sent = 1, status = 'completed' WHERE id = ?").run(id);
    },
    markAnnounced(id) {
      db.prepare("UPDATE competitions SET announced = 1 WHERE id = ?").run(id);
    },
    dueCompetitions(nowMs) {
      return db
        .prepare(
          "SELECT * FROM competitions WHERE status = 'active' AND summary_sent = 0 AND ends_at <= ?",
        )
        .all(nowMs);
    },
    competitor(competitionId, wallet) {
      return (
        db
          .prepare("SELECT * FROM competitors WHERE competition_id = ? AND wallet = ?")
          .get(competitionId, wallet) || null
      );
    },
    competitors(competitionId, status = null) {
      if (status) {
        return db
          .prepare(
            "SELECT * FROM competitors WHERE competition_id = ? AND status = ? ORDER BY entered_at ASC",
          )
          .all(competitionId, status);
      }
      return db
        .prepare("SELECT * FROM competitors WHERE competition_id = ? ORDER BY entered_at ASC")
        .all(competitionId);
    },
    upsertCompetitor(row) {
      db.prepare(
        `INSERT INTO competitors(competition_id, wallet, entered_at, total_bought_raw, balance_raw, sold_raw, status, disqualified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(competition_id, wallet) DO UPDATE SET
           entered_at = excluded.entered_at,
           total_bought_raw = excluded.total_bought_raw,
           balance_raw = excluded.balance_raw,
           sold_raw = excluded.sold_raw,
           status = excluded.status,
           disqualified_at = excluded.disqualified_at`,
      ).run(
        row.competitionId,
        row.wallet,
        row.enteredAt,
        row.totalBoughtRaw,
        row.balanceRaw,
        row.soldRaw || "0",
        row.status,
        row.disqualifiedAt,
      );
    },
    session(userId) {
      const row = db.prepare("SELECT state, data FROM sessions WHERE user_id = ?").get(String(userId));
      if (!row) return { state: "idle", data: {} };
      try {
        return { state: row.state, data: JSON.parse(row.data) };
      } catch {
        return { state: row.state, data: {} };
      }
    },
    setSession(userId, state, data = {}) {
      db.prepare(
        `INSERT INTO sessions(user_id, state, data) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data`,
      ).run(String(userId), state, JSON.stringify(data));
    },
    clearSession(userId) {
      this.setSession(userId, "idle", {});
    },
    enqueueAlert(signature, wallet, payload) {
      db.prepare(
        `INSERT INTO outbox(signature, wallet, payload) VALUES (?, ?, ?)
         ON CONFLICT(signature, wallet) DO UPDATE SET payload = excluded.payload`,
      ).run(signature, wallet, JSON.stringify(payload));
    },
    takeOutbox(signature) {
      return db.prepare("SELECT signature, wallet, payload FROM outbox WHERE signature = ?").all(signature);
    },
    pendingOutbox(limit = 20) {
      return db.prepare("SELECT signature, wallet, payload FROM outbox ORDER BY rowid ASC LIMIT ?").all(limit);
    },
    dropOutbox(signature, wallet) {
      db.prepare("DELETE FROM outbox WHERE signature = ? AND wallet = ?").run(signature, wallet);
    },
    activeLottery() {
      return db.prepare("SELECT * FROM lotteries WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() || null;
    },
    drawingLottery() {
      return db.prepare("SELECT * FROM lotteries WHERE status = 'drawing' ORDER BY id DESC LIMIT 1").get() || null;
    },
    liveLottery() {
      return (
        db.prepare("SELECT * FROM lotteries WHERE status IN ('active', 'drawing') ORDER BY id DESC LIMIT 1").get() ||
        null
      );
    },
    lottery(id) {
      return db.prepare("SELECT * FROM lotteries WHERE id = ?").get(id) || null;
    },
    createLottery(row) {
      const result = db
        .prepare(
          `INSERT INTO lotteries(ticket_usd, tiers_json, duration_days, prize_text, decimals, started_at, ends_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(row.ticketUsd, row.tiersJson, row.durationDays, row.prizeText, row.decimals, row.startedAt, row.endsAt);
      return Number(result.lastInsertRowid);
    },
    setLotteryStatus(id, status) {
      db.prepare("UPDATE lotteries SET status = ? WHERE id = ?").run(status, id);
    },
    setLotteryEndsAt(id, endsAt) {
      db.prepare("UPDATE lotteries SET ends_at = ? WHERE id = ?").run(endsAt, id);
    },
    markDrawing(id, winner, startedAt) {
      db.prepare("UPDATE lotteries SET status = 'drawing', winner = ?, draw_started_at = ? WHERE id = ?").run(
        winner,
        startedAt,
        id,
      );
    },
    setDrawMessage(id, chatId, messageId) {
      db.prepare("UPDATE lotteries SET draw_chat_id = ?, draw_message_id = ? WHERE id = ?").run(
        String(chatId),
        messageId,
        id,
      );
    },
    finishLottery(id, winner) {
      db.prepare("UPDATE lotteries SET status = 'completed', winner = ? WHERE id = ?").run(winner, id);
    },
    lotteryBuySeen(lotteryId, signature, wallet) {
      return Boolean(
        db
          .prepare("SELECT 1 AS ok FROM lottery_buys WHERE lottery_id = ? AND signature = ? AND wallet = ?")
          .get(lotteryId, signature, wallet),
      );
    },
    awardLotteryBuy(row) {
      const existing = this.lotteryWallet(row.lotteryId, row.wallet);
      db.exec("BEGIN");
      try {
        const seen = db
          .prepare("INSERT INTO lottery_buys(lottery_id, signature, wallet) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
          .run(row.lotteryId, row.signature, row.wallet);
        if (seen.changes !== 1 || existing?.status === "disqualified") {
          db.exec("COMMIT");
          return null;
        }
        const saved = this.addLotteryTickets(row);
        db.exec("COMMIT");
        return saved;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    markLotteryBuy(lotteryId, signature, wallet) {
      const result = db
        .prepare("INSERT INTO lottery_buys(lottery_id, signature, wallet) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .run(lotteryId, signature, wallet);
      return result.changes === 1;
    },
    lotteryWallet(lotteryId, wallet) {
      return (
        db.prepare("SELECT * FROM lottery_wallets WHERE lottery_id = ? AND wallet = ?").get(lotteryId, wallet) ||
        null
      );
    },
    lotteryWallets(lotteryId, status = null) {
      if (status) {
        return db
          .prepare(
            "SELECT * FROM lottery_wallets WHERE lottery_id = ? AND status = ? ORDER BY tickets DESC, wallet ASC",
          )
          .all(lotteryId, status);
      }
      return db
        .prepare("SELECT * FROM lottery_wallets WHERE lottery_id = ? ORDER BY tickets DESC, wallet ASC")
        .all(lotteryId);
    },
    addLotteryTickets(row) {
      const existing = this.lotteryWallet(row.lotteryId, row.wallet);
      if (existing?.status === "disqualified") return existing;
      const tickets = (existing?.tickets || 0) + row.tickets;
      const earned = (existing?.tickets_earned || 0) + row.tickets;
      const usd = Number(existing?.usd_spent || 0) + Number(row.usd || 0);
      const net = (BigInt(existing?.net_raw || "0") + BigInt(row.netRaw || "0")).toString();
      db.prepare(
        `INSERT INTO lottery_wallets(lottery_id, wallet, tickets, tickets_earned, usd_spent, net_raw, status, disqualified_at)
         VALUES (?, ?, ?, ?, ?, ?, 'eligible', NULL)
         ON CONFLICT(lottery_id, wallet) DO UPDATE SET
           tickets = excluded.tickets,
           tickets_earned = excluded.tickets_earned,
           usd_spent = excluded.usd_spent,
           net_raw = excluded.net_raw`,
      ).run(row.lotteryId, row.wallet, tickets, earned, usd, net);
      return this.lotteryWallet(row.lotteryId, row.wallet);
    },
    disqualifyLotteryWallet(row) {
      const existing = this.lotteryWallet(row.lotteryId, row.wallet);
      const earned = existing?.tickets_earned || 0;
      const net = (BigInt(existing?.net_raw || "0") - BigInt(row.soldRaw || "0")).toString();
      const hadTickets = (existing?.tickets || 0) > 0;
      db.prepare(
        `INSERT INTO lottery_wallets(lottery_id, wallet, tickets, tickets_earned, usd_spent, net_raw, status, disqualified_at)
         VALUES (?, ?, 0, ?, ?, ?, 'disqualified', ?)
         ON CONFLICT(lottery_id, wallet) DO UPDATE SET
           tickets = 0,
           net_raw = excluded.net_raw,
           status = 'disqualified',
           disqualified_at = excluded.disqualified_at`,
      ).run(row.lotteryId, row.wallet, earned, Number(existing?.usd_spent || 0), net, row.at);
      return { hadTickets, earned };
    },
  };
}
