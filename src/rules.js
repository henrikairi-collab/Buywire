/**
 * Buy-competition decisions.
 *
 * A wallet enters only when a buy during the competition leaves its on-chain
 * balance at or above the threshold. A later transfer-in does not enter it.
 * Once eligible, any drop under the threshold disqualifies it for good.
 * Buying back above the line does not reinstate it.
 */

/**
 * A wallet enters on tokens bought after the competition started, not on the
 * bag it already held. Selling those tokens back under the line is final.
 *
 * @param {{ status?: string, positionRaw: bigint, thresholdRaw: bigint, entriesOpen?: boolean }} input
 * @returns {"watching" | "eligible" | "disqualified"}
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

export function shouldAlert(amountRaw, minRaw) {
  return amountRaw >= minRaw;
}
