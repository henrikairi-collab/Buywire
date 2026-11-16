import { randomInt as cryptoRandomInt } from "node:crypto";
import { escapeHtml, shortAddress } from "./format.js";

export const DRAW_MS = 5 * 60 * 1000;

export function ticketsForBuy(usd, ticketPrice, tiers) {
  const priceCents = Math.round(Number(ticketPrice) * 100);
  const usdCents = Math.round(Number(usd) * 100);
  if (!(priceCents > 0) || !(usdCents >= priceCents)) {
    return { base: 0, bonus: 0, total: 0, tierMin: null };
  }
  const base = Math.floor(usdCents / priceCents);
  const list = Array.isArray(tiers) ? [...tiers] : [];
  list.sort((a, b) => Number(b.min) - Number(a.min));
  const tier = list.find((row) => usdCents + 1 >= Math.round(Number(row.min) * 100));
  const bonus = tier ? Math.max(0, Math.floor(Number(rowBonus(tier)))) : 0;
  return { base, bonus, total: base + bonus, tierMin: tier ? Number(tier.min) : null };
}

function rowBonus(tier) {
  return tier.bonus ?? tier.bonus_tickets ?? 0;
}

export function pickWinner(entries, randomIntFn = cryptoRandomInt) {
  const rows = (entries || []).filter((row) => row.tickets > 0);
  const total = rows.reduce((sum, row) => sum + row.tickets, 0);
  if (!rows.length || total <= 0) return null;
  let ticket = randomIntFn(total);
  for (const row of rows) {
    if (ticket < row.tickets) return row.wallet;
    ticket -= row.tickets;
  }
  return rows[rows.length - 1].wallet;
}

export function spinCursor(elapsedMs, count, winnerIndex) {
  if (count <= 1) return 0;
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed >= DRAW_MS) return winnerIndex;
  const slowSteps = Math.min(count, 20);
  const fastMs = DRAW_MS - slowSteps * 1000;
  if (elapsed < fastMs) return Math.floor(elapsed / 500) % count;
  const steps = Math.min(slowSteps, Math.floor((elapsed - fastMs) / 1000));
  const start = (winnerIndex - (slowSteps % count) + count) % count;
  return (start + steps) % count;
}

export function renderSpin({ prize, wallets, cursor, remainMs, winner, done }) {
  const rows = [...wallets].sort((a, b) => b.tickets - a.tickets || a.wallet.localeCompare(b.wallet));
  const remain = Math.max(0, remainMs);
  const mm = Math.floor(remain / 60000);
  const ss = Math.floor((remain % 60000) / 1000);
  const clock = `${mm}:${String(ss).padStart(2, "0")}`;
  const lines = [
    "🎰 <b>TRENCH LOTTERY</b>",
    escapeHtml(prize || ""),
    done ? "Winner locked" : `Draw in ${clock}`,
    "",
  ];
  const max = 28;
  let windowStart = 0;
  if (rows.length > max) {
    windowStart = Math.max(0, Math.min(cursor - 8, rows.length - max));
  }
  const slice = rows.slice(windowStart, windowStart + max);
  const focus = done ? winner : rows[cursor]?.wallet;
  for (const row of slice) {
    const selected = row.wallet === focus;
    const arrow = done && selected ? "🟢" : selected ? "🔴" : "▪️";
    lines.push(`${arrow} ${escapeHtml(shortAddress(row.wallet))} · ${row.tickets}`);
  }
  if (rows.length > slice.length) lines.push(`+${rows.length - slice.length} more`);
  return lines.join("\n").slice(0, 4000);
}

export function renderLeaderboard(rows) {
  const list = (rows || [])
    .filter((row) => row.tickets > 0 && row.status !== "disqualified")
    .sort((a, b) => b.tickets - a.tickets || a.wallet.localeCompare(b.wallet));
  if (!list.length) return "No tickets yet.";
  return list
    .map((row) => `${shortAddress(row.wallet)} · ${row.tickets}`)
    .join("\n")
    .slice(0, 3900);
}
