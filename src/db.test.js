import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./db.js";

test("signature claim is idempotent and stuck rows can be released", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buywire-"));
  const db = openDatabase(path.join(dir, "t.sqlite"));
  assert.equal(db.claim("abc"), true);
  assert.equal(db.claim("abc"), false);
  db.markEffects("abc");
  db.release("abc");
  assert.ok(db.seen("abc"));
  db.claim("fresh");
  db.resetStuck();
  assert.equal(db.seen("fresh"), null);
  assert.ok(db.seen("abc"));
  db.close();
});

test("buy events and competition rows survive a second write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buywire-"));
  const db = openDatabase(path.join(dir, "t.sqlite"));
  const id = db.createCompetition({
    thresholdUi: "1000000",
    thresholdRaw: "1000000000000",
    decimals: 6,
    durationDays: 7,
    prizeText: "$25 of SOL",
    startedAt: 1,
    endsAt: 2,
  });
  assert.equal(db.recordBuy("sig", "wallet", "5"), true);
  assert.equal(db.recordBuy("sig", "wallet", "5"), false);
  assert.equal(db.hasBuy("sig", "wallet"), true);
  db.upsertCompetitor({
    competitionId: id,
    wallet: "wallet",
    enteredAt: 10,
    totalBoughtRaw: "5",
    balanceRaw: "5",
    status: "eligible",
    disqualifiedAt: null,
  });
  db.upsertCompetitor({
    competitionId: id,
    wallet: "wallet",
    enteredAt: 10,
    totalBoughtRaw: "9",
    balanceRaw: "4",
    status: "disqualified",
    disqualifiedAt: 12,
  });
  const row = db.competitor(id, "wallet");
  assert.equal(row.status, "disqualified");
  assert.equal(row.total_bought_raw, "9");
  db.setEndsAt(id, 50);
  assert.equal(db.competition(id).ends_at, 50);
  db.close();
});
