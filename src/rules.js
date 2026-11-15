/**
 * Buy-competition decisions.
 *
 * A wallet enters only when a buy during the competition leaves its on-chain
 * balance at or above the threshold. A later transfer-in does not enter it.
 * Once eligible, any drop under the threshold disqualifies it for good.
 * Buying back above the line does not reinstate it.
 */

/**
 * @param {{ status?: string, balanceRaw: bigint, thresholdRaw: bigint, buyRaw: bigint }} input
 * @returns {"watching" | "eligible" | "disqualified"}
 */
export function decideEntry({ status, balanceRaw, thresholdRaw, buyRaw }) {
  const current = status || "watching";
  if (current === "disqualified") return "disqualified";
  if (current === "eligible") {
    return balanceRaw < thresholdRaw ? "disqualified" : "eligible";
  }
  if (buyRaw > 0n && balanceRaw >= thresholdRaw) return "eligible";
  return "watching";
}

export function shouldAlert(amountRaw, minRaw) {
  return amountRaw >= minRaw;
}
