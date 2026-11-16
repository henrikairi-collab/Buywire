/**
 * Buy-competition decisions.
 *
 * A wallet enters only when a buy during the competition leaves its on-chain
 * balance at or above the threshold. A later transfer-in does not enter it.
 * Once eligible, any drop under the threshold disqualifies it for good.
 * Buying back above the line does not reinstate it.
 */

/**
 * A wallet enters on the dollar value of tokens bought after the competition
 * started, priced at the time of each buy. Selling those tokens reduces that
 * credit. Dropping under the dollar line is final.
 *
 * @param {{ status?: string, positionRaw: bigint, thresholdRaw: bigint, entriesOpen?: boolean }} input
 */
export function decideEntry({ status, positionRaw, thresholdRaw, entriesOpen = true }) {
  const current = status || "watching";
  if (current === "disqualified") return "disqualified";
  if (current === "eligible") {
    return positionRaw < thresholdRaw ? "disqualified" : "eligible";
  }
  if (!entriesOpen) return "watching";
  if (positionRaw >= thresholdRaw) return "eligible";
  return "watching";
}

export function remainingCredit(grossCents, boughtRaw, positionRaw) {
  const gross = BigInt(grossCents || 0);
  const bought = BigInt(boughtRaw || 0);
  const position = BigInt(positionRaw || 0);
  if (gross <= 0n || bought <= 0n || position <= 0n) return 0n;
  const held = position > bought ? bought : position;
  return (gross * held) / bought;
}

export function shouldAlert(amountRaw, minRaw) {
  return amountRaw >= minRaw;
}
