import assert from "node:assert/strict";
import test from "node:test";
import { parseTokenAmount, uiStringToRaw } from "./format.js";
import { parseEnhancedTransaction, parseRawTransaction } from "./parse.js";
import { decideEntry, shouldAlert } from "./rules.js";

const MINT = "Mint111111111111111111111111111111111111111";
const USER = "User111111111111111111111111111111111111111";
const POOL = "Pool111111111111111111111111111111111111111";
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

test("enhanced swap output is a buy for the payer only", () => {
  const parsed = parseEnhancedTransaction(
    {
      signature: "sig-buy",
      timestamp: 1_700_000_000,
      type: "SWAP",
      source: "RAYDIUM",
      feePayer: USER,
      tokenTransfers: [
        { mint: MINT, tokenAmount: 2_000_000, fromUserAccount: POOL, toUserAccount: USER },
      ],
      events: {
        swap: {
          nativeInput: { account: USER, amount: "1500000000" },
          tokenInputs: [],
          tokenOutputs: [
            {
              userAccount: USER,
              mint: MINT,
              rawTokenAmount: { tokenAmount: "2000000000000", decimals: 6 },
            },
            {
              userAccount: "FeeWallet11111111111111111111111111111111",
              mint: MINT,
              rawTokenAmount: { tokenAmount: "1000", decimals: 6 },
            },
          ],
        },
      },
    },
    MINT,
  );
  assert.equal(parsed.buys.length, 1);
  assert.equal(parsed.buys[0].wallet, USER);
  assert.equal(parsed.buys[0].dex, "Raydium");
  assert.equal(parsed.buys[0].amountUi, 2_000_000);
  assert.equal(parsed.buys[0].solSpent, 1.5);
});

test("a sell does not alert the pool that received the token", () => {
  const parsed = parseEnhancedTransaction(
    {
      signature: "sig-sell",
      timestamp: 1_700_000_100,
      type: "SWAP",
      source: "ORCA",
      feePayer: USER,
      tokenTransfers: [
        { mint: MINT, tokenAmount: 500_000, fromUserAccount: USER, toUserAccount: POOL },
      ],
      events: {
        swap: {
          nativeOutput: { account: USER, amount: "1000000000" },
          tokenInputs: [
            {
              userAccount: USER,
              mint: MINT,
              rawTokenAmount: { tokenAmount: "500000000000", decimals: 6 },
            },
          ],
          tokenOutputs: [],
        },
      },
    },
    MINT,
  );
  assert.equal(parsed.buys.length, 0);
  const user = parsed.changes.find((change) => change.wallet === USER);
  assert.ok(user.deltaUi < 0);
});

test("plain transfers are not buys", () => {
  const parsed = parseEnhancedTransaction(
    {
      signature: "sig-transfer",
      timestamp: 1_700_000_200,
      type: "TRANSFER",
      source: "SYSTEM_PROGRAM",
      feePayer: USER,
      tokenTransfers: [{ mint: MINT, tokenAmount: 100, fromUserAccount: USER, toUserAccount: POOL }],
      events: {},
    },
    MINT,
  );
  assert.equal(parsed.buys.length, 0);
});

test("raw swap credits the signer, not the pool", () => {
  const buy = parseRawTransaction(
    {
      blockTime: 1_700_000_300,
      transaction: {
        signatures: ["raw-buy"],
        message: {
          accountKeys: [
            { pubkey: USER, signer: true, writable: true },
            { pubkey: RAYDIUM, signer: false, writable: false },
          ],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [2_000_000_000, 0],
        postBalances: [400_000_000, 0],
        preTokenBalances: [
          { mint: MINT, owner: USER, uiTokenAmount: { amount: "0", decimals: 6 } },
        ],
        postTokenBalances: [
          { mint: MINT, owner: USER, uiTokenAmount: { amount: "1000000000000", decimals: 6 } },
          { mint: MINT, owner: POOL, uiTokenAmount: { amount: "5000000000000", decimals: 6 } },
        ],
        logMessages: ["Program log: Instruction: Swap"],
      },
    },
    MINT,
  );
  assert.equal(buy.buys.length, 1);
  assert.equal(buy.buys[0].wallet, USER);
  assert.equal(buy.buys[0].dex, "Raydium");

  const sell = parseRawTransaction(
    {
      blockTime: 1_700_000_400,
      transaction: {
        signatures: ["raw-sell"],
        message: {
          accountKeys: [
            { pubkey: USER, signer: true, writable: true },
            { pubkey: RAYDIUM, signer: false, writable: false },
          ],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [400_000_000, 0],
        postBalances: [1_400_000_000, 0],
        preTokenBalances: [
          { mint: MINT, owner: USER, uiTokenAmount: { amount: "2000000000000", decimals: 6 } },
          { mint: MINT, owner: POOL, uiTokenAmount: { amount: "1000000000000", decimals: 6 } },
        ],
        postTokenBalances: [
          { mint: MINT, owner: USER, uiTokenAmount: { amount: "1500000000000", decimals: 6 } },
          { mint: MINT, owner: POOL, uiTokenAmount: { amount: "1500000000000", decimals: 6 } },
        ],
        logMessages: ["Program log: Instruction: Swap"],
      },
    },
    MINT,
  );
  assert.equal(sell.buys.length, 0);
});

test("competition examples from the brief", () => {
  const threshold = uiStringToRaw("1000000", 6);
  const twoMillion = uiStringToRaw("2000000", 6);
  const onePointFive = uiStringToRaw("1500000", 6);
  const under = uiStringToRaw("900000", 6);

  assert.equal(
    decideEntry({ status: "watching", balanceRaw: twoMillion, thresholdRaw: threshold, buyRaw: twoMillion }),
    "eligible",
  );
  assert.equal(
    decideEntry({ status: "eligible", balanceRaw: onePointFive, thresholdRaw: threshold, buyRaw: 0n }),
    "eligible",
  );
  assert.equal(
    decideEntry({ status: "eligible", balanceRaw: under, thresholdRaw: threshold, buyRaw: 0n }),
    "disqualified",
  );
  assert.equal(
    decideEntry({ status: "disqualified", balanceRaw: twoMillion, thresholdRaw: threshold, buyRaw: twoMillion }),
    "disqualified",
  );
  assert.equal(
    decideEntry({ status: "watching", balanceRaw: twoMillion, thresholdRaw: threshold, buyRaw: 0n }),
    "watching",
  );
  assert.equal(shouldAlert(twoMillion, threshold), true);
  assert.equal(shouldAlert(under, threshold), false);
});

test("token amount shorthand", () => {
  assert.equal(parseTokenAmount("1.5m"), "1500000");
  assert.equal(parseTokenAmount("2,500"), "2500");
  assert.equal(parseTokenAmount("0.5"), "0.5");
  assert.equal(parseTokenAmount("nope"), null);
  assert.equal(uiStringToRaw("1", 6), 1_000_000n);
});
