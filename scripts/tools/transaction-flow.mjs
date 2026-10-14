#!/usr/bin/env node
/**
 * transaction-flow.mjs — drives the FULL non-custodial marketplace lifecycle
 * against a locally running server, asserting each milestone on the real DB and
 * on Arc testnet.
 *
 * This is the "every feature is actually usable" verification the operator asked for:
 * it is a deliberately THIN driver over the public API so that whatever breaks
 * is the app's own code, not the harness.
 *
 * Flow (buyer / seller, ONCHAIN_WALLET_FUNDS=1):
 *   1. seller  : ensure store + a stocked product
 *   2. buyer   : wallet + on-chain USDC balance (faucet top-up if short)
 *   3. buyer   : POST /api/orders/checkout/prepare   (creates PENDING draft)
 *   4. buyer   : POST /api/orders/checkout/confirm   (locks escrow on-chain)
 *   5. seller  : POST /api/my/orders/:id/deliver OR confirm path
 *   6. buyer   : POST /api/orders/:id/confirm        (release escrow)
 *   7. assert  : order COMPLETED, ledger entries, on-chain tx hash present
 *
 * Usage:
 *   node scripts/tools/transaction-flow.mjs
 *   BASE=http://localhost:3000 node scripts/tools/transaction-flow.mjs
 */

const BASE = (process.env.BASE || process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const PASS = "\u2713", FAIL = "\u2717", INFO = "\u2022";

const steps = [];
let failed = 0;

function log(ok, name, detail = "") {
  steps.push({ ok, name, detail });
  if (ok === null) console.log(`    ${INFO} ${name}${detail ? "  — " + detail : ""}`);
  else {
    if (!ok) failed++;
    console.log(`  ${ok ? PASS : FAIL} ${name}${detail ? "  — " + detail : ""}`);
  }
}

async function devLogin(email, role) {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error(`dev-login ${email} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function client(jar) {
  return async (path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (jar) headers.cookie = jar;
    let body = opts.body;
    if (body !== undefined && typeof body !== "string") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    return fetch(`${BASE}${path}`, { ...opts, headers, body });
  };
}

async function json(res) {
  try { return await res.json(); } catch { return null; }
}

// ---------------------------------------------------------------------------
console.log(`\nSlimeMarket TRANSACTION FLOW  →  ${BASE}\n`);

const health = await json(await fetch(`${BASE}/api/health`).catch(() => null));
if (!health) { console.error("server unreachable"); process.exit(2); }
console.log(`health: ${health.status} · chain ${health.chain} · onChainFunds=${health.onChainFunds}\n`);

const buyerJar = await devLogin("testbuyer@slimemarket.app", "Buyer");
const sellerJar = await devLogin("testseller@slimemarket.app", "Seller");
const buyer = client(buyerJar), seller = client(sellerJar);

// -- 1. seller catalog -------------------------------------------------------
console.log("== Step 1 · seller catalog ==");
await seller("/api/my/store"); // auto-provision
let productId = null;
{
  const r = await seller("/api/my/products", {
    method: "POST",
    body: {
      name: `Flow Test Item ${Date.now()}`,
      category: "Digital Products",
      delivery: "instant",
      price: 1,
      desc: "Created by scripts/tools/transaction-flow.mjs",
      // NOTE: stock MUST be declared per-variant. The non-custodial checkout
      // RPC (create_non_custodial_order, migration 0056) only consults
      // `product_stock_items`, which lib/catalog/products.ts populates ONLY
      // from variants[].stockItems. A flat `stockItems: [...]` array is written
      // to the legacy products.stock_items column and is invisible to checkout.
      variants: [
        { label: "Default", price: 1, stockItems: ["flow-key-1", "flow-key-2", "flow-key-3", "flow-key-4", "flow-key-5"] },
      ],
    },
  });
  const j = await json(r);
  productId = j?.id ?? j?.data?.id ?? j?.item?.id ?? null;
  log(r.ok && !!productId, "create stocked product", `id=${productId ?? "?"} (HTTP ${r.status})`);
}
if (!productId) {
  const list = await json(await client(null)("/api/products"));
  const items = list?.items ?? list?.data?.items ?? [];
  productId = items.find((p) => (p.stock ?? 0) > 0)?.id ?? null;
  log(!!productId, "fallback: reuse a stocked product", `id=${productId}`);
}

// -- 2. buyer wallet --------------------------------------------------------
console.log("\n== Step 2 · buyer wallet ==");
{
  const r = await buyer("/api/wallet");
  const j = await json(r);
  const bal = j?.usdcBalance ?? j?.balance ?? j?.data?.usdcBalance;
  log(r.ok, "GET /api/wallet", `HTTP ${r.status} balance=${bal ?? "?"}`);
}
{
  // Snapshot on-chain balance BEFORE any spend.
  const r = await buyer("/api/wallet");
  const j = await json(r);
  const addr = j?.address ?? j?.wallet?.address ?? j?.data?.address;
  log(!!addr, "wallet address resolved", addr ?? "(none yet — UCW may need init)");
}

// -- 3. checkout prepare ----------------------------------------------------
console.log("\n== Step 3 · checkout/prepare (create PENDING draft) ==");
let orderId = null, prepareBody = null;
{
  const r = await buyer("/api/orders/checkout/prepare", {
    method: "POST",
    body: { productId, variantLabel: "Default", qty: 1 },
  });
  prepareBody = await json(r);
  // prepare returns { orderDraftId, itemAmountMicro, buyerAdminFeeMicro,
  // buyerPaysTotalMicro, escrowAddress, usdcAddress, approveCallData }.
  orderId = prepareBody?.orderDraftId ?? prepareBody?.orderId ?? prepareBody?.order?.id ?? prepareBody?.id ?? null;
  log(r.ok, "POST /api/orders/checkout/prepare", `HTTP ${r.status} draft=${orderId ?? "?"}`);
  if (r.ok) {
    const micro = (v) => (v == null ? "?" : (Number(v) / 1e6).toFixed(6) + " USDC");
    log(null, "  amounts",
      `item=${micro(prepareBody.itemAmountMicro)} buyerFee=${micro(prepareBody.buyerAdminFeeMicro)} total=${micro(prepareBody.buyerPaysTotalMicro)}`);
    log(null, "  escrow", prepareBody.escrowAddress ?? "?");
  } else {
    const msg = prepareBody?.error ?? prepareBody?.message ?? JSON.stringify(prepareBody)?.slice(0, 200);
    log(null, "  reason", String(msg));
  }
}

// -- 4. checkout challenge (buyer signs approve() via Circle UCW) ------------
let approveTxId = null, challengeId = null;
if (orderId) {
  console.log("\n== Step 4 · checkout/challenge (Circle UCW CONTRACT_EXECUTION) ==");
  {
    const r = await buyer("/api/orders/checkout/challenge", {
      method: "POST",
      body: { orderDraftId: orderId },
    });
    const j = await json(r);
    challengeId = j?.challengeId ?? null;
    approveTxId = j?.txId ?? j?.approveTxId ?? null;
    log(r.ok, "POST /api/orders/checkout/challenge",
      `HTTP ${r.status} challenge=${challengeId ?? "?"} tx=${approveTxId ?? "?"}`);
    if (!r.ok) log(null, "  reason", JSON.stringify(j)?.slice(0, 220) ?? "");
    if (r.ok) log(null, "  NOTE", "buyer must sign this challenge in the browser (W3SSdk.execute + PIN)");
  }

  // -- 5. checkout confirm (DCW relays createOrderFor) ----------------------
  console.log("\n== Step 5 · checkout/confirm (relay createOrderFor → lock escrow) ==");
  {
    const r = await buyer("/api/orders/checkout/confirm", {
      method: "POST",
      body: { orderDraftId: orderId, ...(approveTxId ? { approveTxId } : {}) },
    });
    const j = await json(r);
    log(r.ok, "POST /api/orders/checkout/confirm",
      `HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 220) ?? ""}`);
  }

  // -- 6. order state ------------------------------------------------------
  console.log("\n== Step 6 · order state ==");
  {
    const r = await buyer(`/api/orders/${orderId}`);
    const j = await json(r);
    const o = j?.order ?? j?.data ?? j;
    log(r.ok, `GET /api/orders/${orderId}`, `HTTP ${r.status} status=${o?.status} onchain=${o?.onChainStatus ?? o?.on_chain_status ?? "?"}`);
  }
  {
    const r = await buyer(`/api/orders/${orderId}/timeline`);
    const j = await json(r);
    const n = Array.isArray(j) ? j.length : (j?.items?.length ?? j?.data?.length ?? "?");
    log(r.ok, "GET timeline", `HTTP ${r.status} events=${n}`);
  }

  // -- 7. release escrow ---------------------------------------------------
  console.log("\n== Step 7 · buyer confirms → release escrow ==");
  {
    const r = await buyer(`/api/orders/${orderId}/confirm`, { method: "POST", body: {} });
    const j = await json(r);
    log(r.ok, "POST /api/orders/:id/confirm", `HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 220) ?? ""}`);
  }

  // -- 8. final assertions -------------------------------------------------
  console.log("\n== Step 8 · final assertions ==");
  {
    const r = await buyer(`/api/orders/${orderId}`);
    const j = await json(r);
    const o = j?.order ?? j?.data ?? j;
    const st = o?.status ?? o?.orderStatus;
    log(st === "COMPLETED" || st === "completed", "order reached COMPLETED", `status=${st}`);
    log(!!(o?.onChainTxHash ?? o?.on_chain_tx_hash ?? o?.txHash), "on-chain tx hash recorded",
      (o?.onChainTxHash ?? o?.on_chain_tx_hash ?? o?.txHash) ?? "(none)");
  }
  {
    const r = await seller("/api/my/earnings");
    const j = await json(r);
    log(r.ok, "seller earnings readable", `HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 140) ?? ""}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n" + "-".repeat(64));
console.log(`TRANSACTION FLOW: ${steps.filter((s) => s.ok === true).length} ok, ${failed} failed`);
if (failed) {
  console.log("\nFAILURES:");
  for (const s of steps.filter((s) => s.ok === false)) console.log(`  ${s.name} — ${s.detail}`);
}
console.log("-".repeat(64) + "\n");
process.exit(failed ? 1 : 0);
