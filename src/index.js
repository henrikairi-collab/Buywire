import http from "node:http";
import { openDatabase } from "./db.js";
import { createEngine } from "./engine.js";
import { createLogger } from "./log.js";
import { createTelegram } from "./telegram.js";
import { shortAddress } from "./format.js";

process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && String(warning.message).includes("SQLite")) return;
  console.warn(warning.stack || warning.message);
});

function loadConfig() {
  const heliusKey = process.env.HELIUS_API_KEY || "";
  let publicUrl = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (!publicUrl && process.env.RENDER_EXTERNAL_URL) {
    publicUrl = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
  }
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    adminIds: (process.env.ADMIN_TELEGRAM_IDS || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
    mint: (process.env.TOKEN_MINT || "HZXfbN8D6cYiZfKeep8kSM5pjEngaXh1TC8oAB4hpump").trim(),
    symbol: (process.env.TOKEN_SYMBOL || "TRENCHMAS").trim(),
    heliusKey,
    rpc:
      process.env.SOLANA_RPC_URL ||
      (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : ""),
    publicUrl,
    webhookSecret: process.env.HELIUS_WEBHOOK_SECRET || "",
    port: Number(process.env.PORT) || 8787,
    databasePath: process.env.DATABASE_PATH || "./data/buywire.sqlite",
    logPath: process.env.LOG_PATH || "./data/buywire.log",
    alertChatId: (process.env.ALERT_CHAT_ID || "").trim(),
    minBuy: process.env.MIN_BUY_TOKENS || "0",
  };
}

function readBody(req, limit = 5_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req, secret) {
  if (!secret) return true;
  const header = req.headers.authorization || "";
  return header === secret || header === `Bearer ${secret}`;
}

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logPath);
  const db = openDatabase(config.databasePath);
  const status = {
    stream: "down",
    webhook: config.heliusKey ? "starting" : "no-key",
    telegram: "starting",
    lastTxAt: null,
    lastAlertAt: null,
    startedAt: Date.now(),
    timers: [],
  };
  const ctx = { config, log, db, status, engine: null, telegram: null };
  if (!config.rpc) log.error("No RPC url. Set HELIUS_API_KEY or SOLANA_RPC_URL.");

  ctx.engine = createEngine(ctx);
  ctx.telegram = createTelegram(ctx);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const comp = db.activeCompetition();
        const body = {
          ok: true,
          service: "buywire",
          telegram: status.telegram,
          mint: ctx.engine.mint() ? shortAddress(ctx.engine.mint()) : null,
          stream: status.stream,
          webhook: status.webhook,
          lastTxAt: status.lastTxAt,
          lastAlertAt: status.lastAlertAt,
          uptimeSec: Math.floor((Date.now() - status.startedAt) / 1000),
          competition: comp
            ? {
                id: comp.id,
                endsAt: comp.ends_at,
                eligible: db.competitors(comp.id, "eligible").length,
                disqualified: db.competitors(comp.id, "disqualified").length,
              }
            : null,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      if (req.method === "POST" && url.pathname === "/webhook/helius") {
        if (!authorized(req, config.webhookSecret)) {
          log.warn("webhook rejected: bad authorization header");
          res.writeHead(401);
          res.end("unauthorized");
          return;
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "[]");
        } catch {
          res.writeHead(400);
          res.end("bad json");
          return;
        }
        const list = Array.isArray(payload) ? payload : [payload];
        log.info("webhook batch", { count: list.length });
        for (const tx of list) {
          await ctx.engine.ingestEnhanced(tx);
        }
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      log.error("http handler failed", { err, path: url.pathname });
      if (!res.headersSent) {
        res.writeHead(err.status || 500);
        res.end("error");
      }
    }
  });

  await new Promise((resolve) => server.listen(config.port, "0.0.0.0", resolve));
  log.info("http listening", { port: config.port, publicUrl: config.publicUrl || null });

  ctx.engine.start();
  await ctx.telegram.start();

  const shutdown = (signal) => {
    log.info("shutting down", { signal });
    ctx.telegram.stop();
    ctx.engine.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (err) => {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "unhandledRejection", err: String(err?.stack || err) }));
});

process.on("uncaughtException", (err) => {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "uncaughtException", err: String(err?.stack || err) }));
  setTimeout(() => process.exit(1), 300);
});

main().catch((err) => {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "boot failed", err: String(err?.stack || err) }));
  process.exit(1);
});
