/**
 * wl-deal-action.mjs — run a WL deal action (markDelivered / confirmEscrow /
 * flagDispute) through the UCW rail instead of an external wallet.
 *
 * This is the counterpart to `runDealAction` in public/app.jsx: it asks
 * `/action-challenge` for a Circle CONTRACT_EXECUTION challenge, signs it with
 * the caller's own device, then posts the resulting txHash to the existing
 * verify route. Before the action-challenge endpoint existed, only
 * `window.WalletBridge` could produce that txHash, so email-only (UCW) users
 * could not complete an escrow.
 *
 * Usage:
 *   node scripts/tools/wl-deal-action.mjs --session .secrets/ucw-<x>.json \
 *     --deal <uuid> --action markDelivered --route mark-delivered --pin 123456
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
const action = arg("action");
const route = arg("route");
const PIN = arg("pin", "123456");
if (!sessionPath || !existsSync(sessionPath)) { console.error("--session <path> required"); process.exit(2); }
if (!dealId || !action || !route) { console.error("--deal, --action and --route are required"); process.exit(2); }

const SHOT_DIR = path.join(REPO, ".secrets", "shots");
mkdirSync(SHOT_DIR, { recursive: true });

let failed = 0;
const log = (ok, name, detail = "") => {
  console.log(`  ${ok === null ? "\u2022" : ok ? "\u2713" : "\u2717"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok === false) failed++;
};

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

console.log(`\n[1] ${action}: action-challenge`);
const chal = await api(`/api/wl/deals/${dealId}/action-challenge`, { body: { action } });
log(chal.ok, "POST action-challenge", `${chal.status} ${JSON.stringify(chal.json).slice(0, 200)}`);
if (!chal.ok) { await browser.close(); process.exit(1); }
const challengeId = chal.json.challengeId;
const devBypass = chal.json.devBypass === true;

let txHash = chal.json.txId ?? null;
if (!devBypass) {
  console.log("\n[2] sign in the browser");
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
    if (settled) {
      log(settled.ok, `round ${round}: SDK settled`, JSON.stringify(settled).slice(0, 160));
      if (settled.ok) txHash = settled.txHash ?? settled.txId ?? txHash;
      break;
    }
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
      if (n > 0) { await boxes.first().click({ timeout: 4000 }); await page.keyboard.type(PIN, { delay: 120 }); log(null, "  typed PIN"); acted = true; }
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

await page.screenshot({ path: path.join(SHOT_DIR, `wl-action-${action}.png`), fullPage: true }).catch(() => {});
log(null, "txHash", String(txHash).slice(0, 70));

console.log(`\n[3] verify: POST ${route}`);
const done = await api(`/api/wl/deals/${dealId}/${route}`, { body: { txHash } });
log(done.ok, `POST ${route}`, `${done.status} ${JSON.stringify(done.json).slice(0, 220)}`);

const st = await api(`/api/wl/deals/${dealId}`, { method: "GET" });
log(null, "deal state", JSON.stringify(st.json).slice(0, 240));

await browser.close();
console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
