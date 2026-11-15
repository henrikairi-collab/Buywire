export function rpcUrl(config) {
  if (config.rpc) return config.rpc;
  return "";
}

export function wsUrl(config) {
  if (process.env.SOLANA_WS_URL) return process.env.SOLANA_WS_URL;
  const rpc = rpcUrl(config);
  if (rpc.startsWith("https://")) return `wss://${rpc.slice("https://".length)}`;
  if (rpc.startsWith("http://")) return `ws://${rpc.slice("http://".length)}`;
  return "";
}

export function createChain(config, log) {
  let rpcId = 1;

  async function rpc(method, params) {
    const url = rpcUrl(config);
    if (!url) throw new Error("No Solana RPC configured");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || `RPC ${method} failed`);
    return body.result;
  }

  return {
    rpc,
    async signatures(mint, before) {
      const options = { limit: 100, commitment: "confirmed" };
      if (before) options.before = before;
      const rows = await rpc("getSignaturesForAddress", [mint, options]);
      return Array.isArray(rows) ? rows : [];
    },
    async transaction(signature) {
      return rpc("getTransaction", [
        signature,
        {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ]);
    },
    async mintInfo(mint) {
      const result = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
      const decimals = result?.value?.data?.parsed?.info?.decimals;
      if (decimals == null) return null;
      return { decimals: Number(decimals) };
    },
    async balanceRaw(wallet, mint) {
      const result = await rpc("getTokenAccountsByOwner", [
        wallet,
        { mint },
        { encoding: "jsonParsed" },
      ]);
      let total = 0n;
      let decimals = null;
      for (const row of result?.value || []) {
        const amount = row?.account?.data?.parsed?.info?.tokenAmount;
        if (!amount?.amount) continue;
        total += BigInt(amount.amount);
        decimals = Number(amount.decimals ?? decimals ?? 0);
      }
      return { raw: total, decimals };
    },
    async heliusParse(signatures) {
      if (!config.heliusKey || !signatures.length) return [];
      const response = await fetch(
        `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${encodeURIComponent(config.heliusKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transactions: signatures }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) throw new Error(`Helius parse HTTP ${response.status}`);
      const body = await response.json();
      return Array.isArray(body) ? body : [];
    },
    async assetSymbol(mint) {
      if (!config.heliusKey) return null;
      try {
        const result = await rpc("getAsset", [{ id: mint }]);
        return result?.content?.metadata?.symbol || null;
      } catch (err) {
        log.warn("getAsset failed", { err });
        return null;
      }
    },
  };
}

const WEBHOOK_URL = "https://api-mainnet.helius-rpc.com/v0/webhooks";

export async function syncHeliusWebhook({ config, log, mint, publicUrl, secret, existingId }) {
  if (!config.heliusKey) return { state: "no-key", id: null };
  if (!publicUrl) return { state: "needs-url", id: existingId || null };
  if (!mint) return { state: "needs-mint", id: existingId || null };

  const webhookURL = `${publicUrl}/webhook/helius`;
  const payload = {
    webhookURL,
    webhookType: "enhanced",
    accountAddresses: [mint],
    transactionTypes: ["ANY"],
    txnStatus: "success",
    authHeader: secret || undefined,
  };

  const headers = { "content-type": "application/json" };
  const key = encodeURIComponent(config.heliusKey);

  let id = existingId || null;
  if (!id) {
    const listed = await fetch(`${WEBHOOK_URL}?api-key=${key}`, { signal: AbortSignal.timeout(15_000) });
    if (listed.ok) {
      const rows = await listed.json();
      const found = (Array.isArray(rows) ? rows : []).find(
        (row) => row.webhookURL === webhookURL || (row.accountAddresses || []).includes(mint),
      );
      if (found?.webhookID) id = found.webhookID;
    }
  }

  const endpoint = id ? `${WEBHOOK_URL}/${id}?api-key=${key}` : `${WEBHOOK_URL}?api-key=${key}`;
  const response = await fetch(endpoint, {
    method: id ? "PUT" : "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text();
    log.error("helius webhook upsert failed", { status: response.status, text: text.slice(0, 400) });
    return { state: "error", id };
  }
  const body = await response.json();
  log.info("helius webhook ready", { id: body.webhookID || id, webhookURL });
  return { state: "registered", id: body.webhookID || id };
}
