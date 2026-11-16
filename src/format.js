/** Decimal and display helpers. Amounts the admin types are UI tokens, not raw units. */

export function parseTokenAmount(input) {
  const s = String(input).trim().toLowerCase().replace(/[, _]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return null;
  let [whole, frac = ""] = m[1].split(".");
  const zeros = m[2] === "k" ? 3 : m[2] === "m" ? 6 : m[2] === "b" ? 9 : 0;
  if (zeros) {
    const padded = frac.padEnd(zeros, "0");
    whole += padded.slice(0, zeros);
    frac = padded.slice(zeros).replace(/0+$/, "");
  }
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  frac = frac.replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function uiStringToRaw(ui, decimals) {
  const s = String(ui).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Not a token amount: ${ui}`);
  }
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) {
    throw new Error(`Bad decimals: ${decimals}`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > dec) {
    throw new Error(`${ui} has more precision than ${dec} decimals`);
  }
  const fracPadded = frac.padEnd(dec, "0");
  const base = 10n ** BigInt(dec);
  return BigInt(whole) * base + BigInt(fracPadded || "0");
}

export function rawToNumber(raw, decimals) {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const dec = Number(decimals);
  const base = 10n ** BigInt(dec);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / base;
  const frac = abs % base;
  const n = Number(whole) + Number(frac) / Number(base);
  return neg ? -n : n;
}

export function formatRaw(raw, decimals) {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const dec = Number(decimals);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(dec);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (abs % base).toString().padStart(dec, "0").replace(/0+$/, "");
  if (dec === 0) frac = "";
  const body = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${body}` : body;
}

export function formatTokenUi(ui) {
  const n = Number(ui);
  if (!Number.isFinite(n)) return String(ui);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const trim = (value) => value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  if (abs >= 1e9) return `${sign}${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${trim(abs / 1e3)}K`;
  return `${sign}${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function parseUsd(input) {
  const s = String(input).trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return null;
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function formatUiString(ui) {
  const parsed = parseTokenAmount(ui);
  if (!parsed) return String(ui);
  const [whole, frac] = parsed.split(".");
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${withCommas}.${frac}` : withCommas;
}

export function shortAddress(address) {
  const s = String(address || "");
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function formatUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a";
  const n = Number(value);
  if (n >= 1000) {
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  if (n >= 1) {
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (n > 0 && n < 0.000001) return `$${n.toExponential(2)}`;
  return `$${n.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`;
}

export function formatDuration(ms) {
  let left = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(left / 86400);
  left -= days * 86400;
  const hours = Math.floor(left / 3600);
  left -= hours * 3600;
  const minutes = Math.floor(left / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatTimestamp(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function isMintAddress(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value).trim());
}

export function parseDays(input) {
  const n = Number(String(input).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 3650) return null;
  return n;
}

export function emojiForAmount(amountUi, tiers, mode, customEmoji) {
  if (mode === "custom" && String(customEmoji || "").trim()) {
    return String(customEmoji).trim();
  }
  const list = Array.isArray(tiers) ? [...tiers] : [];
  list.sort((a, b) => Number(b.min) - Number(a.min));
  for (const tier of list) {
    if (amountUi + 1e-12 >= Number(tier.min) && tier.emoji) return tier.emoji;
  }
  return "●";
}

export function emojiBar(usd, tiers, mode, customEmoji) {
  const glyph = emojiForAmount(usd, tiers, mode, customEmoji);
  const count = Number.isFinite(usd) && usd > 0 ? Math.min(15, Math.max(1, Math.floor(usd / 10))) : 1;
  return glyph.repeat(count);
}

export function chunkText(text, size = 3500) {
  const lines = String(text).split("\n");
  const parts = [];
  let buf = "";
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > size && buf) {
      parts.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) parts.push(buf);
  return parts.length ? parts : [""];
}
