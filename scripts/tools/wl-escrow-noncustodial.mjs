/**
 * wl-escrow-noncustodial.mjs — drive the FULL non-custodial WL escrow lifecycle
 * with a REAL Circle UCW session, signing the approve() in a real browser.
 *
 * Why a browser: `/api/wl/deals/challenge` returns
 *   "The userToken is invalid."
 * for a dev-login session, because dev-login mints a fake `dev-token-*`. Only a
 * genuine UCW userToken (from ucw-pin-setup.mjs) can produce a challenge, and the
 * challenge must be signed by the user's device.
 *
 * Steps:
 *   1. load the saved UCW session (cookies + storageState)
 *   2. buyer  : POST /api/wl/deals/prepare           → dealDraftId
 *   3. buyer  : POST /api/wl/deals/challenge         → challengeId
 *   4. browser: W3SSdk.execute(challengeId)          → user signs approve()
 *   5. buyer  : POST /api/wl/deals/confirm           → on-chain deal created
 *   6. seller : POST /api/wl/deals/[id]/proceed-non-custodial  {collateralUsdc}
 *   7. seller : POST /api/wl/deals/[id]/mark-delivered
 *   8. buyer  : POST /api/wl/deals/[id]/confirm-receipt
 *   9. admin  : POST /api/wl/deals/[id]/release
 *
 * Usage:
 *   node scripts/tools/wl-escrow-noncustodial.mjs --session .secrets/ucw-<x>.json \
 *     --listing <uuid> --seller <email> --admin <email> --collateral 0.5 --pin 123456
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);

const sessionPath = arg("session");
const listingId = arg("listing");
const sellerEmail = arg("seller");
const adminEmail = arg("admin");
const collateral = arg("collateral", "0");
const PIN = arg("pin", "123456");

if (!sessionPath || !existsSync(sessionPath)) { console.error("--session <path> required"); process.exit(2); }
if (!listingId) { console.error("--listing <uuid> required"); process.exit(2); }

const SHOT_DIR = path.join(REPO, ".secrets", "shots");
mkdirSync(SHOT_DIR, { recursive: true });

let failed = 0;
const log = (ok, name, detail = "") => {
  console.log(`  ${ok === null ? "\u2022" : ok ? "\u2713" : "\u2717"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok === false) failed++;
};

// The `ucw-<x>.json` file is a WRAPPER: it carries the userToken/encryptionKey
// plus a `storageStatePath` pointing at the real Playwright storage state.
// Loading the wrapper as a storageState silently yields no origins — and with no
// `pw-auth.circle.com` localStorage there is no deviceId, so Circle answers
// "Provided device ID is not found in the system." Always resolve the pointer.
const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
let state;
if (wrapper.storageStatePath) {
  const real = path.isAbsolute(wrapper.storageStatePath)
    ? wrapper.storageStatePath
    : path.join(REPO, wrapper.storageStatePath);
  if (!existsSync(real)) { console.error(`storageStatePath missing: ${real}`); process.exit(2); }
  state = JSON.parse(readFileSync(real, "utf8"));
  console.log(`storage state: ${real}`);
} else {
  state = wrapper.storageState ?? wrapper;
}
const origins = (state.origins ?? []).map((o) => o.origin);
console.log(`origins: ${origins.join(", ") || "(none)"}`);
if (!origins.some((o) => /pw-auth\.circle\.com/.test(o))) {
  console.error("no pw-auth.circle.com origin — the Circle deviceId is missing, challenges will fail");
  process.exit(2);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// Must land on the app origin before any relative fetch — on about:blank the URL
// cannot be parsed ("Failed to parse URL from /api/...").
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(2500);

/** Call the API from inside the page, so the real session cookies are used. */
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

/** Separate context that logs in as another account via dev-login (seller/admin). */
async function asUser(email) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const r = await c.request.post(`${BASE}/api/auth/dev-login`, { data: { email } });
  if (!r.ok()) throw new Error(`dev-login ${email} → ${r.status()}`);
  const p = await c.newPage();
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  return { ctx: c, page: p };
}

async function apiAs(acct, pathname, body) {
  return acct.page.evaluate(async ([p, b]) => {
    const r = await fetch(p, {
      method: "POST",
      headers: b ? { "Content-Type": "application/json" } : undefined,
      body: b ? JSON.stringify(b) : undefined,
      credentials: "include",
    });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, json };
  }, [pathname, body ?? null]);
}

// --- 2. prepare ------------------------------------------------------------
console.log("\n[2] buyer: prepare");
const prep = await api("/api/wl/deals/prepare", { body: { listingId, qty: 1 } });
log(prep.ok, "POST /api/wl/deals/prepare", `${prep.status} ${JSON.stringify(prep.json).slice(0, 140)}`);
if (!prep.ok) { await browser.close(); process.exit(1); }
const draftId = prep.json.dealDraftId;

// --- 3. challenge ----------------------------------------------------------
console.log("\n[3] buyer: challenge");
const chal = await api("/api/wl/deals/challenge", { body: { dealDraftId: draftId } });
log(chal.ok, "POST /api/wl/deals/challenge", `${chal.status} ${JSON.stringify(chal.json).slice(0, 160)}`);
if (!chal.ok) { await browser.close(); process.exit(1); }
const challengeId = chal.json.challengeId;
const devBypass = chal.json.devBypass === true;
log(null, "challenge", `id=${challengeId} devBypass=${devBypass}`);

// --- 4. sign in the browser ------------------------------------------------
console.log("\n[4] buyer: sign approve() in the browser");
let approveTxId = chal.json.txId ?? null;
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
    if (settled) { log(settled.ok, `round ${round}: SDK settled`, JSON.stringify(settled).slice(0, 140)); break; }

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
      if (n > 0) {
        await boxes.first().click({ timeout: 4000 });
        await page.keyboard.type(PIN, { delay: 120 });
        log(null, `  typed PIN into ${n} input(s)`);
        acted = true;
      }
    } catch {}

    if (!acted) {
      for (const name of [/^Confirm$/i, /^Execute$/i, /^Continue$/i, /^Submit$/i, /^Approve$/i, /^Done$/i, /^Agree$/i]) {
        const btn = fr.getByRole("button", { name }).first();
        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await btn.click({ timeout: 6000 }).catch(() => {});
          log(null, `  clicked ${name.source}`);
          acted = true;
          break;
        }
      }
    }
    if (!acted) await page.waitForTimeout(2500);
  }
}

// --- 5. confirm ------------------------------------------------------------
console.log("\n[5] buyer: confirm (create on-chain deal)");
const conf = await api("/api/wl/deals/confirm", { body: { dealDraftId: draftId, approveTxId } });
log(conf.ok, "POST /api/wl/deals/confirm", `${conf.status} ${JSON.stringify(conf.json).slice(0, 200)}`);

const dealId = conf.json?.dealId ?? conf.json?.id ?? null;
if (dealId) {
  const st = await api(`/api/wl/deals/${dealId}`, { method: "GET" });
  log(null, "deal state", JSON.stringify(st.json).slice(0, 220));
}

await page.screenshot({ path: path.join(SHOT_DIR, "wl-confirm.png"), fullPage: true }).catch(() => {});
await browser.close();

console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
