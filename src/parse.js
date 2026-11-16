import { rawToNumber } from "./format.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const QUOTE_SYMBOL = {
  [SOL_MINT]: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

const SOURCE_NAMES = {
  JUPITER: "Jupiter",
  RAYDIUM: "Raydium",
  RAYDIUM_CLMM: "Raydium",
  RAYDIUM_CP: "Raydium",
  RAYDIUM_AMM: "Raydium",
  ORCA: "Orca",
  WHIRLPOOL: "Orca",
  METEORA: "Meteora",
  METEORA_DAMM: "Meteora",
  METEORA_DLMM: "Meteora",
  PUMP_FUN: "Pump.fun",
  PUMP_AMM: "PumpSwap",
  PUMPSWAP: "PumpSwap",
  MOONSHOT: "Moonshot",
  LIFINITY: "Lifinity",
  PHOENIX: "Phoenix",
  OPENBOOK: "OpenBook",
  FLUXBEAM: "Fluxbeam",
};

const PROGRAM_NAMES = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: "Jupiter",
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: "Phoenix",
  opnb2LAfJYbRMALvyFXZV9TDt3S9j2aU6A5S5fU7A: "OpenBook",
};

function pubkeyOf(key) {
  return typeof key === "string" ? key : key?.pubkey;
}

export function accountKeysOf(tx) {
  const message = tx?.transaction?.message || tx?.message || {};
  const loaded = tx?.meta?.loadedAddresses || {};
  const keys = [
    ...(message.accountKeys || []),
    ...(loaded.writable || []),
    ...(loaded.readonly || []),
  ];
  return keys.map((key, index) => {
    if (typeof key === "string") {
      return { pubkey: key, signer: index === 0 };
    }
    return { pubkey: key.pubkey, signer: Boolean(key.signer) };
  });
}

export function dexFromSource(source) {
  if (!source) return null;
  const key = String(source).toUpperCase().replace(/[\s-]+/g, "_");
  return SOURCE_NAMES[key] || null;
}

export function dexFromKeys(keys) {
  const found = [];
  for (const key of keys) {
    const name = PROGRAM_NAMES[key.pubkey];
    if (name && !found.includes(name)) found.push(name);
  }
  if (!found.length) return null;
  if (found.length === 1) return found[0];
  const venue = found.find((name) => name !== "Jupiter");
  return venue ? `Jupiter · ${venue}` : found[0];
}

function uiFromRawToken(rawTokenAmount) {
  if (!rawTokenAmount || rawTokenAmount.tokenAmount == null) return null;
  const decimals = Number(rawTokenAmount.decimals ?? 0);
  let raw;
  try {
    raw = BigInt(rawTokenAmount.tokenAmount);
  } catch {
    return null;
  }
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  return {
    raw: abs,
    negative: neg,
    decimals,
    ui: rawToNumber(abs, decimals),
  };
}

function netTransfers(tx, mint) {
  const nets = new Map();
  for (const transfer of tx.tokenTransfers || []) {
    if (transfer.mint !== mint) continue;
    const amount = Number(transfer.tokenAmount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    if (transfer.toUserAccount) {
      nets.set(transfer.toUserAccount, (nets.get(transfer.toUserAccount) || 0) + amount);
    }
    if (transfer.fromUserAccount) {
      nets.set(
        transfer.fromUserAccount,
        (nets.get(transfer.fromUserAccount) || 0) - amount,
      );
    }
  }
  return nets;
}

function paymentFor(swap, wallet) {
  let solSpent = 0;
  if (swap?.nativeInput?.account === wallet) {
    solSpent = Number(swap.nativeInput.amount) / 1e9;
  }
  let quoteSymbol = null;
  let quoteUi = 0;
  for (const input of swap?.tokenInputs || []) {
    if (input.userAccount && input.userAccount !== wallet) continue;
    const parsed = uiFromRawToken(input.rawTokenAmount);
    if (!parsed || parsed.negative) continue;
    const symbol = QUOTE_SYMBOL[input.mint] || null;
    if (!symbol && input.mint !== SOL_MINT) continue;
    if (parsed.ui > quoteUi) {
      quoteUi = parsed.ui;
      quoteSymbol = symbol || "SOL";
    }
  }
  return { solSpent: Number.isFinite(solSpent) ? solSpent : 0, quoteSymbol, quoteUi };
}

function buyersFromSwap(swap, mint) {
  if (!swap) return [];
  const outputs = (swap.tokenOutputs || []).filter((output) => output.mint === mint);
  const used = outputs.length ? outputs : [];
  if (!used.length && Array.isArray(swap.innerSwaps)) {
    for (const inner of swap.innerSwaps) {
      for (const output of inner.tokenOutputs || []) {
        if (output.mint === mint) used.push(output);
      }
    }
  }
  const payers = new Set();
  if (swap.nativeInput?.account) payers.add(swap.nativeInput.account);
  for (const input of swap.tokenInputs || []) {
    if (input.userAccount) payers.add(input.userAccount);
  }
  for (const inner of swap.innerSwaps || []) {
    if (inner.nativeInput?.account) payers.add(inner.nativeInput.account);
    for (const input of inner.tokenInputs || []) {
      if (input.userAccount) payers.add(input.userAccount);
    }
  }
  const buys = [];
  for (const output of used) {
    const wallet = output.userAccount;
    const parsed = uiFromRawToken(output.rawTokenAmount);
    if (!wallet || !parsed || parsed.negative || parsed.raw === 0n) continue;
    if (payers.size && !payers.has(wallet)) continue;
    buys.push({
      wallet,
      amountRaw: parsed.raw.toString(),
      decimals: parsed.decimals,
      amountUi: parsed.ui,
      ...paymentFor(swap, wallet),
    });
  }
  return buys;
}

function dedupeBuys(buys) {
  const byWallet = new Map();
  for (const buy of buys) {
    const prev = byWallet.get(buy.wallet);
    if (!prev || BigInt(buy.amountRaw) > BigInt(prev.amountRaw)) {
      byWallet.set(buy.wallet, buy);
    }
  }
  return [...byWallet.values()];
}

/**
 * Helius enhanced transaction → buys where `mint` is the swap output,
 * plus every wallet whose net mint balance changed.
 */
export function parseEnhancedTransaction(tx, mint) {
  if (!tx?.signature || tx.transactionError) return null;
  const nets = netTransfers(tx, mint);
  const dex =
    dexFromSource(tx.source) ||
    dexFromKeys((tx.accountData || []).map((row) => ({ pubkey: row.account }))) ||
    "DEX";
  const timestamp = Number(tx.timestamp) || Math.floor(Date.now() / 1000);
  let buys = buyersFromSwap(tx.events?.swap, mint).map((buy) => ({
    ...buy,
    dex,
    signature: tx.signature,
    timestamp,
  }));

  const looksLikeSwap =
    String(tx.type || "").toUpperCase() === "SWAP" || /swapped/i.test(tx.description || "");
  if (!buys.length && looksLikeSwap && tx.feePayer) {
    const delta = nets.get(tx.feePayer) || 0;
    if (delta > 0) {
      const decimals = Number(tx.events?.swap?.tokenOutputs?.[0]?.rawTokenAmount?.decimals ?? 0);
      const amountRaw =
        decimals > 0 ? uiApproxRaw(delta, decimals) : uiApproxRaw(delta, 0);
      buys = [
        {
          wallet: tx.feePayer,
          amountRaw,
          decimals,
          amountUi: delta,
          solSpent: 0,
          quoteSymbol: null,
          quoteUi: 0,
          dex,
          signature: tx.signature,
          timestamp,
        },
      ];
    }
  }

  return {
    signature: tx.signature,
    timestamp,
    dex,
    changes: [...nets.entries()]
      .filter(([, delta]) => delta !== 0)
      .map(([wallet, deltaUi]) => ({ wallet, deltaUi })),
    buys: dedupeBuys(buys),
  };
}

export function uiApproxRaw(ui, decimals) {
  const negative = ui < 0;
  const abs = Math.abs(ui);
  const [whole, frac = ""] = abs.toFixed(Math.min(decimals, 9)).split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  return (negative ? -raw : raw).toString();
}

/** Helius sometimes gives the human amount with decimals omitted. Scale it once. */
export function normalizeAmount(buy, mintDecimals) {
  const ui = Number(buy.amountUi);
  const dec = Number(buy.decimals) > 0 ? Number(buy.decimals) : Number(mintDecimals);
  if (!Number.isInteger(dec) || dec < 0 || !Number.isFinite(ui) || ui <= 0) {
    return { ...buy, decimals: Number.isInteger(dec) ? dec : 0 };
  }
  let raw = 0n;
  try {
    raw = BigInt(buy.amountRaw);
  } catch {
    raw = 0n;
  }
  const scaled = BigInt(uiApproxRaw(ui, dec));
  const rawNumber = Number(raw);
  const tooSmall = !Number.isFinite(rawNumber) || rawNumber < (ui * 10 ** dec) / 100;
  return {
    ...buy,
    amountRaw: (tooSmall ? scaled : raw).toString(),
    decimals: dec,
    amountUi: ui,
  };
}

function balancesByOwner(rows, mint) {
  const map = new Map();
  let decimals = null;
  for (const row of rows || []) {
    if (row.mint !== mint || !row.owner) continue;
    const amount = row.uiTokenAmount?.amount;
    if (amount == null) continue;
    decimals = Number(row.uiTokenAmount.decimals ?? decimals ?? 0);
    const prev = map.get(row.owner) || 0n;
    map.set(row.owner, prev + BigInt(amount));
  }
  return { map, decimals: decimals ?? 0 };
}

function quotePaidBy(meta, owner, mint) {
  const pre = new Map();
  const post = new Map();
  const decimals = new Map();
  for (const row of meta.preTokenBalances || []) {
    if (!row.owner || row.owner !== owner || row.mint === mint) continue;
    pre.set(row.mint, (pre.get(row.mint) || 0n) + BigInt(row.uiTokenAmount.amount));
    decimals.set(row.mint, Number(row.uiTokenAmount.decimals ?? 0));
  }
  for (const row of meta.postTokenBalances || []) {
    if (!row.owner || row.owner !== owner || row.mint === mint) continue;
    post.set(row.mint, (post.get(row.mint) || 0n) + BigInt(row.uiTokenAmount.amount));
    decimals.set(row.mint, Number(row.uiTokenAmount.decimals ?? 0));
  }
  const mints = new Set([...pre.keys(), ...post.keys()]);
  let best = null;
  for (const tokenMint of mints) {
    const delta = (post.get(tokenMint) || 0n) - (pre.get(tokenMint) || 0n);
    if (delta >= 0n) continue;
    const dec = decimals.get(tokenMint) || 0;
    const ui = rawToNumber(-delta, dec);
    const symbol = QUOTE_SYMBOL[tokenMint] || (tokenMint === SOL_MINT ? "SOL" : null);
    if (!symbol) continue;
    if (!best || ui > best.ui) best = { symbol, ui };
  }
  return best;
}

/**
 * jsonParsed getTransaction result, or the same shape from a websocket.
 * Only signers can be buyers — pool vaults receive the token on a sell and
 * must not page the group.
 */
export function parseRawTransaction(tx, mint, signature) {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;
  const keys = accountKeysOf(tx);
  const sig =
    signature ||
    tx?.transaction?.signatures?.[0] ||
    tx?.signature ||
    null;
  if (!sig) return null;
  const pre = balancesByOwner(meta.preTokenBalances, mint);
  const post = balancesByOwner(meta.postTokenBalances, mint);
  const decimals = post.decimals || pre.decimals || 0;
  const owners = new Set([...pre.map.keys(), ...post.map.keys()]);
  const changes = [];
  for (const owner of owners) {
    const delta = (post.map.get(owner) || 0n) - (pre.map.get(owner) || 0n);
    if (delta === 0n) continue;
    changes.push({ wallet: owner, deltaUi: rawToNumber(delta, decimals) });
  }

  const logs = (meta.logMessages || []).join("\n");
  const dex = dexFromKeys(keys);
  const swapish = Boolean(dex) || /instruction:\s*(swap|buy|route)/i.test(logs);
  const fee = BigInt(meta.fee || 0);
  const buys = [];
  if (swapish) {
    const signers = keys.filter((key) => key.signer).map((key) => key.pubkey);
    for (const signer of signers) {
      const before = pre.map.get(signer) || 0n;
      const after = post.map.get(signer) || 0n;
      const delta = after - before;
      if (delta <= 0n) continue;
      const index = keys.findIndex((key) => key.pubkey === signer);
      let solSpent = 0;
      if (index >= 0 && meta.preBalances && meta.postBalances) {
        const solDelta = BigInt(meta.postBalances[index]) - BigInt(meta.preBalances[index]);
        if (solDelta < -fee) solSpent = rawToNumber(-(solDelta + fee), 9);
      }
      const quote = quotePaidBy(meta, signer, mint);
      if (solSpent <= 0 && !quote) continue;
      buys.push({
        wallet: signer,
        amountRaw: delta.toString(),
        decimals,
        amountUi: rawToNumber(delta, decimals),
        solSpent,
        quoteSymbol: quote?.symbol || (solSpent > 0 ? "SOL" : null),
        quoteUi: quote?.ui || solSpent,
        dex: dex || "DEX",
        signature: sig,
        timestamp: Number(tx.blockTime) || Math.floor(Date.now() / 1000),
      });
    }
  }

  return {
    signature: sig,
    timestamp: Number(tx.blockTime) || Math.floor(Date.now() / 1000),
    dex: dex || "DEX",
    changes,
    buys,
  };
}
