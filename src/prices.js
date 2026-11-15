const SOL_MINT = "So11111111111111111111111111111111111111112";

export function createPrices(log) {
  const cache = new Map();

  async function lookup(mint) {
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.at < 12_000) return hit;
    const next = { at: Date.now(), usd: null, symbol: null, decimals: null };
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) {
        const body = await response.json();
        const pairs = Array.isArray(body.pairs) ? [...body.pairs] : [];
        pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const pair = pairs[0];
        if (pair?.priceUsd) next.usd = Number(pair.priceUsd);
        const token =
          pair?.baseToken?.address === mint ? pair.baseToken : pair?.quoteToken?.address === mint ? pair.quoteToken : pair?.baseToken;
        if (token?.symbol && token.address === mint) next.symbol = token.symbol;
      }
    } catch (err) {
      log.warn("price lookup failed", { mint, err });
    }
    if (next.usd == null && hit?.usd != null) next.usd = hit.usd;
    if (!next.symbol && hit?.symbol) next.symbol = hit.symbol;
    cache.set(mint, next);
    return next;
  }

  return {
    async token(mint) {
      return lookup(mint);
    },
    async sol() {
      return lookup(SOL_MINT);
    },
    usdValue({ amountUi, solSpent, quoteSymbol, quoteUi, tokenUsd, solUsd }) {
      if ((quoteSymbol === "USDC" || quoteSymbol === "USDT") && quoteUi > 0) return quoteUi;
      if (tokenUsd != null && Number.isFinite(tokenUsd) && amountUi > 0) return amountUi * tokenUsd;
      if (solSpent > 0 && solUsd != null && Number.isFinite(solUsd)) return solSpent * solUsd;
      return null;
    },
  };
}
