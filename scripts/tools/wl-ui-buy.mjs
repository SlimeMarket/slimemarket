/**
 * wl-ui-buy.mjs — drive the FULL buyer-side WL Market purchase through the SPA
 * as a UCW (email-login) user, with no external wallet connected.
 *
 * This is the UI twin of wl-escrow-noncustodial.mjs: instead of calling the API
 * directly it clicks a real WL Market card → "Send Order to Seller", so the
 * whole non-custodial path is exercised the way a user triggers it:
 *   prepare → challenge → W3SSdk sign (PIN) → confirm → deal created (WAITING).
 *
 * Usage:
 *   node scripts/tools/wl-ui-buy.mjs --session .secrets/ucw-<x>.json \
 *     --project "Test Escrow Real" --pin 123456 [--qty 1]
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
const project = arg("project");
const PIN = arg("pin", "123456");

if (!sessionPath || !existsSync(sessionPath)) { console.error("--session <path> required"); process.exit(2); }
if (!project) { console.error("--project <listing project name> required"); process.exit(2); }

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
  state = JSON.parse(readFileSync(real, "utf8"));
} else state = wrapper.storageState ?? wrapper;
if (!(state.origins ?? []).some((o) => /pw-auth\.circle\.com/.test(o.origin))) {
  console.error("no pw-auth.circle.com origin"); process.exit(2);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept().catch(() => {}));

const api = {}; // path-suffix → { status, body }
page.on("response", async (r) => {
  const u = r.url();
  const m = u.match(/\/api\/wl\/deals(\/[^?]*)?(\?|$)/);
  if (!m) return;
  const key = (m[1] || "").replace(/^\//, "") || "root";
  let b = ""; try { b = (await r.text()).slice(0, 200); } catch {}
  api[key] = { status: r.status(), body: b };
});

await page.goto(`${BASE}/escrow`, { waitUntil: "domcontentloaded", timeout: 90_000 });

// WL Market is the default tab; wait for the card grid to populate.
let cardsReady = false;
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  const n = await page.locator(`text=${project}`).count().catch(() => 0);
  if (n > 0) { cardsReady = true; break; }
}
log(cardsReady, `WL Market card "${project}" rendered`);
if (!cardsReady) { await browser.close(); console.log("\n1 step(s) failed"); process.exit(1); }

// Open the listing detail modal.
await page.locator(`text=${project}`).first().click({ timeout: 10_000 }).catch(() => {});
let modalOpen = false;
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(500);
  if (await page.getByText(/WL ESCROW DEAL/i).first().isVisible().catch(() => false)) { modalOpen = true; break; }
}
log(modalOpen, "listing detail modal opened");

// Send Order to Seller (EN + ID labels).
const orderBtn = page.getByRole("button", { name: /Send Order to Seller|Kirim Pesanan ke Penjual/i }).first();
const hasOrder = (await orderBtn.count()) > 0;
log(hasOrder, "Send Order to Seller button present");
if (hasOrder) {
  await orderBtn.click({ timeout: 10_000 }).catch(() => {});

  // The UCW rail must NOT ask for an external wallet.
  const sawWalletPrompt = await page.getByText(/connect your wallet/i).first()
    .isVisible({ timeout: 3000 }).catch(() => false);
  log(!sawWalletPrompt, sawWalletPrompt ? "asked for an external wallet (UCW rail NOT taken)" : "no external-wallet prompt");

  // Sign the approve() challenge in the Circle iframe.
  await page.waitForFunction(() => !!document.getElementById("sdkIframe"), { timeout: 30_000 }).catch(() => {});
  for (let round = 1; round <= 12; round++) {
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
}

// Give the relay + confirm round-trip time to land.
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  if (api["confirm"]?.status === 200) break;
}

await page.screenshot({ path: path.join(SHOT_DIR, "wl-ui-buy.png"), fullPage: true }).catch(() => {});

console.log("\n  API:");
for (const [k, v] of Object.entries(api)) log(null, `    ${k} → ${v.status}`, v.body.slice(0, 110));

const prepared = api["prepare"]?.status === 201 || api["prepare"]?.status === 200;
const challenged = api["challenge"]?.status === 201 || api["challenge"]?.status === 200;
const confirmed = api["confirm"]?.status === 200 || api["confirm"]?.status === 201;
log(prepared, "prepare draft created");
log(challenged, "approve() challenge built");
log(confirmed, "confirm → on-chain deal created");
if (confirmed) {
  let body = {}; try { body = JSON.parse(api["confirm"].body); } catch {}
  log(!!body.onChainDealId || body.onChainDealId === "0", "on-chain deal id resolved", `dealId=${body.dealId} onChainDealId=${body.onChainDealId}`);
}

await browser.close();
console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
