/**
 * wl-seller-collateral.mjs — seller side of a non-custodial WL escrow deal.
 *
 * Drives the collateral approve() in a real browser (the seller's UCW device),
 * then hands the tx to proceed-non-custodial so the deal leaves WAITING.
 *
 * Why a browser: `/api/wl/deals/[id]/collateral-challenge` builds a Circle
 * CONTRACT_EXECUTION challenge, and only the seller's own device (deviceId in
 * the saved storageState) can sign it.
 *
 * Usage:
 *   node scripts/tools/wl-seller-collateral.mjs --session .secrets/ucw-<x>.json \
 *     --deal <uuid> --collateral 0.5 --pin 123456
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
const dealId = arg("deal");
const collateral = arg("collateral", "0.5");
const PIN = arg("pin", "123456");
if (!sessionPath || !existsSync(sessionPath)) { console.error("--session <path> required"); process.exit(2); }
if (!dealId) { console.error("--deal <uuid> required"); process.exit(2); }

const SHOT_DIR = path.join(REPO, ".secrets", "shots");
mkdirSync(SHOT_DIR, { recursive: true });

let failed = 0;
const log = (ok, name, detail = "") => {
  console.log(`  ${ok === null ? "\u2022" : ok ? "\u2713" : "\u2717"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok === false) failed++;
};

// Resolve the wrapper → real storageState (must include pw-auth.circle.com).
const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
let state;
if (wrapper.storageStatePath) {
  const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
  if (!existsSync(real)) { console.error(`storageStatePath missing: ${real}`); process.exit(2); }
  state = JSON.parse(readFileSync(real, "utf8"));
} else state = wrapper.storageState ?? wrapper;
const origins = (state.origins ?? []).map((o) => o.origin);
if (!origins.some((o) => /pw-auth\.circle\.com/.test(o))) { console.error("no pw-auth.circle.com origin"); process.exit(2); }
log(null, "session", origins.join(", "));

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(2500);

async function api(pathname, { method = "POST", body } = {}) {
  return page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, {
      method: m,
      headers: b ? { "Content-Type": "application/json" } : undefined,
      body: b ? JSON.stringify(b) : undefined,
      credentials: "include",
    });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, json };
  }, [pathname, method, body ?? null]);
}

// --- 1. collateral challenge ----------------------------------------------
console.log("\n[1] seller: collateral-challenge");
const chal = await api(`/api/wl/deals/${dealId}/collateral-challenge`, { body: { collateralUsdc: collateral } });
log(chal.ok, "POST collateral-challenge", `${chal.status} ${JSON.stringify(chal.json).slice(0, 200)}`);
if (!chal.ok) { await browser.close(); process.exit(1); }
const challengeId = chal.json.challengeId;
const devBypass = chal.json.devBypass === true;

// --- 2. sign ---------------------------------------------------------------
console.log("\n[2] seller: sign the collateral approve()");
if (!devBypass) {
  await page.evaluate((cid) => {
    window.__chalResult = undefined;
    window.executeUcwChallenge(cid)
      .then((r) => { window.__chalResult = { ok: true, ...r }; })
      .catch((e) => { window.__chalResult = { ok: false, error: String(e) }; });
  }, challengeId).catch(() => {});

  await page.waitForFunction(() => !!document.getElementById("sdkIframe"), { timeout: 30_000 }).catch(() => {});
  log(true, "challenge iframe mounted");

  for (let round = 1; round <= 12; round++) {
    const settled = await page.evaluate(() => window.__chalResult).catch(() => null);
    if (settled) { log(settled.ok, `round ${round}: SDK settled`, JSON.stringify(settled).slice(0, 150)); break; }
    const frames = page.frames().filter((f) => /pw-auth\.circle\.com/.test(f.url()));
    if (!frames.length) { log(null, `round ${round}: no Circle frame`); await page.waitForTimeout(2500); continue; }
    const fr = frames[0];
    let body = "";
    try { body = (await fr.locator("body").innerText({ timeout: 5000 })).replace(/\s+/g, " ").trim(); } catch {}
    log(null, `round ${round}: ${fr.url().replace("https://pw-auth.circle.com", "…")} — "${body.slice(0, 70)}"`);

    let acted = false;
    try {
      const boxes = fr.locator('input[type="password"], input[inputmode="numeric"], input[maxlength="1"]');
      const n = await boxes.count();
      if (n > 0) { await boxes.first().click({ timeout: 4000 }); await page.keyboard.type(PIN, { delay: 120 }); log(null, `  typed PIN`); acted = true; }
    } catch {}
    if (!acted) {
      for (const name of [/^Confirm$/i, /^Execute$/i, /^Continue$/i, /^Submit$/i, /^Approve$/i, /^Done$/i, /^Agree$/i]) {
        const btn = fr.getByRole("button", { name }).first();
        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await btn.click({ timeout: 6000 }).catch(() => {});
          log(null, `  clicked ${name.source}`); acted = true; break;
        }
      }
    }
    if (!acted) await page.waitForTimeout(2500);
  }
}

const approveTxId = chal.json.txId ?? null;
await page.screenshot({ path: path.join(SHOT_DIR, "wl-collateral.png"), fullPage: true }).catch(() => {});

// --- 3. proceed ------------------------------------------------------------
// With collateral > 0 this route runs the DB transition AND returns a SECOND
// challenge: depositEscrowCollateral(dealId, amount). The approve above only
// grants the allowance — without signing the deposit the collateral never
// reaches the contract, and a later refundEscrowWithSlash reverts with
// "no collateral to slash" while the DB still claims seller_collateral > 0.
console.log("\n[3] seller: proceed-non-custodial");
const proc = await api(`/api/wl/deals/${dealId}/proceed-non-custodial`, {
  body: { collateralUsdc: collateral, approveTxId, approveTxHash: approveTxId },
});
log(proc.ok, "POST proceed-non-custodial", `${proc.status} ${JSON.stringify(proc.json).slice(0, 200)}`);

const depositChallengeId = proc.json?.challengeId;
const depositDevBypass = proc.json?.devBypass === true;
if (depositChallengeId && depositChallengeId !== "none" && !depositDevBypass) {
  console.log("\n[4] seller: sign the collateral DEPOSIT challenge");
  await page.evaluate((cid) => {
    window.__depResult = undefined;
    window.executeUcwChallenge(cid)
      .then((r) => { window.__depResult = { ok: true, ...r }; })
      .catch((e) => { window.__depResult = { ok: false, error: String(e) }; });
  }, depositChallengeId).catch(() => {});
  await page.waitForFunction(() => !!document.getElementById("sdkIframe"), { timeout: 30_000 }).catch(() => {});

  for (let round = 1; round <= 12; round++) {
    const settled = await page.evaluate(() => window.__depResult).catch(() => null);
    if (settled) { log(settled.ok, `deposit round ${round}: settled`, JSON.stringify(settled).slice(0, 140)); break; }
    const frames = page.frames().filter((f) => /pw-auth\.circle\.com/.test(f.url()));
    if (!frames.length) { await page.waitForTimeout(2500); continue; }
    const fr = frames[0];
    let acted = false;
    try {
      const boxes = fr.locator('input[type="password"], input[inputmode="numeric"], input[maxlength="1"]');
      if (await boxes.count() > 0) { await boxes.first().click({ timeout: 4000 }); await page.keyboard.type(PIN, { delay: 120 }); acted = true; }
    } catch {}
    if (!acted) {
      for (const nm of [/^Confirm$/i, /^Execute$/i, /^Continue$/i, /^Submit$/i, /^Done$/i]) {
        const b2 = fr.getByRole("button", { name: nm }).first();
        if (await b2.isVisible({ timeout: 1500 }).catch(() => false)) { await b2.click({ timeout: 6000 }).catch(() => {}); log(null, `  clicked ${nm.source}`); acted = true; break; }
      }
    }
    if (!acted) await page.waitForTimeout(2500);
  }

  // Prove the deposit. The proceed transition already wrote seller_collateral to
  // the DB, but only this makes it verifiable — without it the row claims
  // collateral the contract never received, and a later slash reverts with
  // "no collateral to slash".
  console.log("\n[5] seller: collateral-confirm");
  const conf = await api(`/api/wl/deals/${dealId}/collateral-confirm`, {
    body: { depositChallengeId },
  });
  log(conf.ok, "POST collateral-confirm", `${conf.status} ${JSON.stringify(conf.json).slice(0, 180)}`);
}

const st = await api(`/api/wl/deals/${dealId}`, { method: "GET" });
log(null, "deal state", JSON.stringify(st.json).slice(0, 240));

await browser.close();
console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
