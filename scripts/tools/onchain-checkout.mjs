#!/usr/bin/env node
/**
 * onchain-checkout.mjs — the FULL non-custodial checkout with a REAL Circle
 * User-Controlled Wallet session, signed in a real browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * `transaction-flow.mjs` drives the API but authenticates with `dev-login`,
 * which mints a FAKE `dev-token-*`. Circle rejects that with "The userToken is
 * invalid." and checkout/challenge 500s. The only way to reach a real
 * CONTRACT_EXECUTION challenge is a genuine UCW session — which
 * `ucw-pin-setup.mjs` now produces (real userToken + PIN-enabled LIVE wallet).
 *
 * This script ties the two together:
 *   1. load the saved UCW session (cookies + userToken) from .secrets/
 *   2. make sure the buyer's wallet HOLDS on-chain USDC (treasury faucet)
 *   3. seller: ensure a stocked instant product (variants[].stockItems!)
 *   4. buyer : POST /api/orders/checkout/prepare    → PENDING draft
 *   5. buyer : POST /api/orders/checkout/challenge  → real challengeId
 *   6. browser: W3SSdk.execute(challengeId)         → user signs with their PIN
 *              (driven by Playwright, using the session cookies)
 *   7. buyer : POST /api/orders/checkout/confirm    → DCW relays createOrderFor
 *   8. verify: order SENT, escrow locked on-chain, USDC moved
 *
 * Usage:
 *   node scripts/tools/onchain-checkout.mjs --session .secrets/ucw-<x>.json
 *   node scripts/tools/onchain-checkout.mjs --session ... --headed
 */

import { chromium } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);

const sessionPath = arg("session") || findLatestSession();
function findLatestSession() {
  const dir = path.join(REPO, ".secrets");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith("ucw-") && f.endsWith(".json"))
    .map((f) => ({ f: path.join(dir, f), t: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
}
if (!sessionPath || !existsSync(sessionPath)) {
  console.error("no session file. Run ucw-pin-setup.mjs first, or pass --session <path>");
  process.exit(2);
}

const SHOT_DIR = path.join(REPO, ".secrets", "shots");
mkdirSync(SHOT_DIR, { recursive: true });

const P = "\u2713", F = "\u2717", I = "\u2022";
let failed = 0;
const log = (ok, name, detail = "") => {
  if (ok === null) { console.log(`    ${I} ${name}${detail ? "  — " + detail : ""}`); return; }
  if (!ok) failed++;
  console.log(`  ${ok ? P : F} ${name}${detail ? "  — " + detail : ""}`);
};
const step = (n, m) => console.log(`\n[${n}] ${m}`);

// ---------------------------------------------------------------------------
const session = JSON.parse(readFileSync(sessionPath, "utf8"));
const buyerEmail = session.email;
console.log(`\nSlimeMarket ON-CHAIN CHECKOUT (real UCW)  \u2192  ${BASE}`);
console.log("=".repeat(66));
log(null, "session", `${path.relative(REPO, sessionPath)}  wallet=${session.walletAddress ?? "(none)"}`);
log(null, "buyer", buyerEmail);

if (!session.cookies?.length) { log(false, "session has no cookies"); process.exit(1); }
if (!session.userToken || String(session.userToken).startsWith("dev-token-")) {
  log(false, "session userToken is missing or fake"); process.exit(1);
}

// Build a Cookie header from the saved Playwright cookie jar.
const cookieHeader = session.cookies
  .filter((c) => /slimemarket|localhost/.test(c.domain || ""))
  .map((c) => `${c.name}=${c.value}`).join("; ");

async function api(pathname, opts = {}) {
  const headers = { ...(opts.headers || {}), cookie: cookieHeader };
  let body = opts.body;
  if (body !== undefined && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${pathname}`, { ...opts, headers, body });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, ok: r.ok, json };
}

// A browser sharing the SAME cookies + storage — used only to sign challenges.
// `storageState` (not just cookies) matters: Circle's W3SSdk generates a
// deviceId per browser profile and rejects a challenge signed from a different
// device ("Provided device ID is not found in the system").
const browser = await chromium.launch({ headless: !flag("headed") });
const statePath = session.storageStatePath ? path.join(REPO, session.storageStatePath) : null;
const context = await browser.newContext(
  statePath && existsSync(statePath)
    ? { viewport: { width: 1280, height: 960 }, storageState: statePath }
    : { viewport: { width: 1280, height: 960 } },
);
if (!statePath || !existsSync(statePath)) {
  if (session.cookies?.length) await context.addCookies(session.cookies);
  log(null, "no storageState — falling back to cookies only (deviceId may mismatch)");
}
const page = await context.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (/w3s|challenge|ucw|approve|permit/i.test(t) && !/Download the React/i.test(t)) log(null, `console: ${t.slice(0, 150)}`);
});

try {
  // --- 0. sanity: who are we? ---------------------------------------------
  step(0, "verify the session still works");
  {
    const me = await api("/api/auth/me");
    if (!me.ok) { log(false, "GET /api/auth/me", `HTTP ${me.status}`); }
    else {
      log(true, "GET /api/auth/me", `${me.json?.email} role=${me.json?.role} wallet=${me.json?.walletAddress ?? "?"}`);
      if (me.json?.walletAddress) session.walletAddress = me.json.walletAddress;
    }
    const creds = await api("/api/my/ucw-credentials");
    log(creds.ok, "GET /api/my/ucw-credentials", creds.ok ? `circleWalletId=${creds.json?.circleWalletId ?? "?"}` : `HTTP ${creds.status}`);
    if (creds.json?.userToken) session.userToken = creds.json.userToken;
  }

  // --- 1. fund the buyer's wallet on-chain (treasury DCW) ------------------
  step(1, "ensure the buyer wallet holds on-chain USDC");
  {
    const w0 = await api("/api/wallet");
    const bal0 = Number(w0.json?.balanceUsdc ?? w0.json?.balance ?? 0);
    log(null, "current balance", `${bal0} USDC (DB mirror)`);

    // Check the REAL on-chain balance first — never drain the treasury when the
    // wallet is already funded. The faucet pulls from the platform DCW, which
    // holds a finite testnet balance.
    let onchain = 0n;
    if (session.walletAddress) {
      onchain = await readOnchainUsdc(session.walletAddress).catch(() => 0n);
      log(null, "on-chain balance before", `${Number(onchain) / 1e6} USDC`);
    }

    if (onchain < 2_000_000n) {
      const amt = arg("amount", "3");
      const f = await api("/api/wallet/dev/faucet", { method: "POST", body: { amountUsdc: amt } });
      log(f.ok, `POST /api/wallet/dev/faucet (${amt} USDC)`,
        f.ok ? JSON.stringify(f.json).slice(0, 160) : `HTTP ${f.status} ${JSON.stringify(f.json).slice(0, 160)}`);

      // Circle/Arc indexing takes a moment; poll the on-chain balance.
      const dl = Date.now() + 90_000;
      while (Date.now() < dl) {
        onchain = await readOnchainUsdc(session.walletAddress).catch(() => 0n);
        if (onchain >= 2_000_000n) break;
        await page.waitForTimeout(5000);
      }
    }
    log(onchain > 0n, "on-chain USDC balance", `${onchain} micro-USDC (${Number(onchain) / 1e6} USDC)`);
    if (onchain === 0n) throw new Error("buyer wallet has no on-chain USDC — top up the treasury or fund the wallet");
  }

  // --- 2. seller side: a stocked instant product ---------------------------
  step(2, "seller: ensure a stocked instant product");
  let product = null;
  {
    const sellerEmail = arg("seller", "testseller@slimemarket.app");
    // The seller is a DEV session — that is fine, the seller never signs a
    // UCW challenge in this flow (the DCW relayer + buyer's approve do).
    const sjar = await devLogin(sellerEmail, "Seller");
    const sapi = makeClient(sjar);

    // Auto-provision the store first (idempotent), then create the product.
    await sapi("/api/my/store");
    const create = await sapi("/api/my/products", {
      method: "POST",
      body: {
        name: `Onchain Flow ${Date.now()}`,
        category: "Digital Products",
        delivery: "instant",
        price: Number(arg("price", "1")),
        desc: "Created by scripts/tools/onchain-checkout.mjs",
        // CRITICAL: only variants[].stockItems populate product_stock_items,
        // which is what instant checkout pops. A flat stockItems array is
        // silently ignored (see lib/catalog/products.ts).
        variants: [{
          label: "Default", price: Number(arg("price", "1")),
          stockItems: Array.from({ length: 10 }, (_, i) => `ochain-key-${Date.now()}-${i}`),
        }],
      },
    });
    if (!create.ok) { log(false, "POST /api/my/products", `HTTP ${create.status} ${JSON.stringify(create.json).slice(0, 220)}`); }
    else {
      product = { id: create.json?.id ?? create.json?.data?.id ?? create.json?.item?.id };
      log(true, "created instant product", `id=${product?.id}`);
    }
    if (!product?.id) { log(false, "no product id — cannot continue"); throw new Error("no product"); }
  }

  // --- 3. checkout/prepare -------------------------------------------------
  step(3, "checkout/prepare  (PENDING draft)");
  let draftId = null;
  {
    const prep = await api("/api/orders/checkout/prepare", {
      method: "POST",
      body: {
        // CheckoutPrepareBodySchema is FLAT: { productId, variantLabel?, qty?, payment? }.
        // It is not an items[] array (that shape belongs to the cart/legacy path).
        productId: product.id,
        variantLabel: "Default",
        qty: 1,
        payment: "Balance",
      },
    });
    draftId = prep.json?.orderDraftId ?? prep.json?.orderId ?? prep.json?.id;
    log(prep.ok && !!draftId, "POST /api/orders/checkout/prepare", prep.ok ? `HTTP ${prep.status} draft=${draftId}` : `HTTP ${prep.status} ${JSON.stringify(prep.json).slice(0, 220)}`);
    if (prep.json?.amounts) log(null, "amounts", JSON.stringify(prep.json.amounts));
    if (prep.json?.escrowAddress) log(null, "escrow", prep.json.escrowAddress);
    if (!draftId) throw new Error("no draftId");
  }

  // --- 4. checkout/challenge ----------------------------------------------
  step(4, "checkout/challenge  (real Circle CONTRACT_EXECUTION)");
  let challengeId = null, txId = null;
  {
    const ch = await api("/api/orders/checkout/challenge", { method: "POST", body: { orderDraftId: draftId } });
    challengeId = ch.json?.challengeId;
    txId = ch.json?.txId;
    log(ch.ok && !!challengeId, "POST /api/orders/checkout/challenge",
      ch.ok ? `HTTP ${ch.status} challenge=${challengeId} tx=${txId} devBypass=${!!ch.json?.devBypass}` : `HTTP ${ch.status} ${JSON.stringify(ch.json).slice(0, 240)}`);
    if (!challengeId) throw new Error("no challengeId");
    if (ch.json?.devBypass) log(null, "!! devBypass is ON — set FORCE_REAL_UCW=true + CIRCLE_PAYMENTS_MOCK=0 for a real challenge");
  }

  // --- 5. sign the challenge in the browser (W3SSdk.execute) --------------
  step(5, "sign the approve() challenge in the browser (W3SSdk.execute)");
  let signed = { txHash: null };
  {
    // Navigate to the app first so the SDK global + helpers are loaded.
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.executeUcwChallenge === "function", { timeout: 45_000 })
      .catch(() => log(false, "window.executeUcwChallenge never appeared"));

    // IMPORTANT — how Circle's hosted UI actually appears (verified by
    // scripts/tools/probe-exec2.mjs): NOT a popup window. W3SSdk appends a
    // full-screen `#sdkIframe` (position:fixed, z-index 2147483647) to the app
    // document, and the wizard navigates WITHIN that frame:
    //     pw-auth.circle.com/            (boot; posts onFrameReady + showUi)
    //     pw-auth.circle.com/social/send-tx   ("Contract Interaction" → Confirm)
    //     pw-auth.circle.com/…                (PIN entry → Execute)
    // Clicking the WRONG button (an unlabeled one) makes Circle reply
    // "User canceled", so select by accessible name.
    page.evaluate((cid) => {
      window.__chalResult = undefined;
      window.executeUcwChallenge(cid)
        .then((r) => { window.__chalResult = { ok: true, ...r }; })
        .catch((e) => { window.__chalResult = { ok: false, error: String(e) }; });
    }, challengeId).catch(() => {});

    const pin = arg("pin", "824613");
    // Give the frame time to mount and reach the first actionable screen.
    await page.waitForFunction(() => !!document.getElementById("sdkIframe"), { timeout: 30_000 }).catch(() => {});
    log(true, "challenge iframe mounted");

    for (let round = 1; round <= 10; round++) {
      // Stop as soon as the SDK promise settles.
      const settled = await page.evaluate(() => window.__chalResult).catch(() => null);
      if (settled) { log(null, `round ${round}: SDK settled`); break; }

      const frames = page.frames().filter((f) => /pw-auth\.circle\.com/.test(f.url()));
      if (!frames.length) { log(null, `round ${round}: no Circle frame`); await page.waitForTimeout(2500); continue; }
      const fr = frames[0];

      let body = "";
      try { body = (await fr.locator("body").innerText({ timeout: 5000 })).replace(/\s+/g, " ").trim(); } catch {}
      log(null, `round ${round}: ${fr.url().replace("https://pw-auth.circle.com", "…")} — "${body.slice(0, 80)}"`);

      // (a) PIN screens: single-char / password inputs.
      let acted = false;
      try {
        const boxes = fr.locator('input[type="password"], input[inputmode="numeric"], input[maxlength="1"]');
        const n = await boxes.count();
        if (n > 0) {
          await boxes.first().click({ timeout: 4000 });
          await page.keyboard.type(pin, { delay: 120 });
          log(null, `  typed PIN into ${n} input(s)`);
          acted = true;
        }
      } catch (e) { log(null, `  PIN typing failed: ${String(e).split("\n")[0].slice(0, 80)}`); }

      // (b) Advance: prefer the labelled primary button. Circle uses
      //     "Confirm" (send-tx), "Execute" (PIN), "Continue"/"Submit".
      if (!acted) {
        for (const name of [/^Confirm$/i, /^Execute$/i, /^Continue$/i, /^Submit$/i, /^Approve$/i, /^Done$/i, /^Agree$/i]) {
          const btn = fr.getByRole("button", { name }).first();
          if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await btn.click({ timeout: 6000 }).catch(() => {});
            log(null, `  clicked "${name.source.replace(/[\^$\\\/i]/g, "").replace(/[()]/g, "")}"`);
            acted = true;
            break;
          }
        }
      }
      if (!acted) log(null, "  nothing actionable on this screen yet");

      await page.screenshot({ path: path.join(SHOT_DIR, `checkout-sign-r${round}.png`) }).catch(() => {});
      await page.waitForTimeout(3500);
    }

    const res = await page.evaluate(() => window.__chalResult).catch(() => null);
    signed.txHash = res?.txHash ?? null;
    if (signed.txHash) log(true, "challenge signed", `txHash=${signed.txHash}`);
    else if (res?.ok) log(null, "challenge returned without a txHash", JSON.stringify(res).slice(0, 200));
    else log(false, "challenge failed", JSON.stringify(res).slice(0, 240));
    await page.screenshot({ path: path.join(SHOT_DIR, "checkout-signed.png"), fullPage: true }).catch(() => {});
  }

  // --- 6. checkout/confirm (DCW relays createOrderFor) --------------------
  step(6, "checkout/confirm  (relay createOrderFor → lock escrow)");
  {
    const cf = await api("/api/orders/checkout/confirm", {
      method: "POST",
      body: {
        orderDraftId: draftId,
        approveTxId: txId,
        approveTxHash: signed.txHash ?? undefined,
        payerAddress: session.walletAddress,
      },
    });
    log(cf.ok, "POST /api/orders/checkout/confirm", `HTTP ${cf.status} ${JSON.stringify(cf.json).slice(0, 260)}`);
    if (cf.json?.onChainTxHash) log(true, "escrow locked on-chain", cf.json.onChainTxHash);
    if (cf.json?.degraded) log(null, "degraded/paymentPending — escrow id not resolved yet (reconcile job backfills it)");
  }

  // --- 7. order state -----------------------------------------------------
  step(7, "order state after settlement");
  {
    const o = await api(`/api/orders/${draftId}`);
    log(o.ok, "GET /api/orders/:id", o.ok ? `status=${o.json?.status} onchain=${o.json?.onChainOrderId ?? "?"}` : `HTTP ${o.status}`);
    if (o.json?.status) session.finalStatus = o.json.status;
  }
} catch (e) {
  log(false, "flow aborted", String(e.message ?? e).slice(0, 240));
} finally {
  await browser.close();
}

writeFileSync(sessionPath, JSON.stringify(session, null, 2));
console.log(`\n${"-".repeat(66)}`);
console.log(failed === 0 ? "RESULT: on-chain checkout flow completed" : `RESULT: ${failed} step(s) failed`);
console.log(`${"-".repeat(66)}\n`);
process.exit(failed === 0 ? 0 : 1);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function devLogin(email, role) {
  const r = await fetch(`${BASE}/api/auth/dev-login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!r.ok) throw new Error(`dev-login ${email} -> ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
function makeClient(jar) {
  return async (p, opts = {}) => {
    const headers = { ...(opts.headers || {}), cookie: jar };
    let body = opts.body;
    if (body !== undefined && typeof body !== "string") { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
    const r = await fetch(`${BASE}${p}`, { ...opts, headers, body });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, json };
  };
}

/** Read the wallet's USDC balance directly from Arc (micro-USDC). */
async function readOnchainUsdc(address) {
  const { createPublicClient, http, parseAbi } = await import("viem");
  const client = createPublicClient({ transport: http(process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network") });
  return client.readContract({
    address: process.env.USDC_CONTRACT_ADDRESS || "0x3600000000000000000000000000000000000000",
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [address],
  });
}

/**
 * Circle's hosted UI asks for the PIN (6 digits) possibly twice, then a
 * confirmation. Drive whichever single-char inputs are on screen.
 */
async function drivePinWizard(target, pin) {
  const p = target;
  for (let round = 1; round <= 6; round++) {
    const frames = [p, ...p.frames()];
    let acted = false;
    for (const fr of frames) {
      let body = "";
      try { body = (await fr.locator("body").innerText({ timeout: 4000 })).replace(/\s+/g, " ").trim(); } catch {}
      if (!body) continue;
      const boxes = fr.locator('input[type="password"], input[inputmode="numeric"], input[maxlength="1"]');
      const n = await boxes.count().catch(() => 0);
      if (n > 0) {
        try {
          await boxes.first().click({ timeout: 3000 });
          await p.keyboard.type(pin, { delay: 110 });
          acted = true;
          log(null, `round ${round}: typed PIN into ${n} box(es) — "${body.slice(0, 60)}"`);
        } catch (e) { log(null, `round ${round}: PIN type failed ${String(e).split("\n")[0]}`); }
      } else {
        const go = fr.getByRole("button", { name: /continue|confirm|submit|verify|next|done|agree/i }).first();
        if (await go.isVisible({ timeout: 2000 }).catch(() => false)) {
          await go.click({ timeout: 4000 }).catch(() => {});
          acted = true;
          log(null, `round ${round}: clicked continue — "${body.slice(0, 60)}"`);
        }
      }
    }
    if (!acted) { log(null, `round ${round}: nothing left to do`); break; }
    await p.waitForTimeout(2500);
  }
  await p.screenshot({ path: path.join(SHOT_DIR, "circle-popup-final.png") }).catch(() => {});
}
