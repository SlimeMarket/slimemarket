/**
 * wl-ui-action.mjs — click a real deal-action button in the SPA as a UCW
 * (email-login) user with no external wallet connected.
 *
 * This is the end-to-end proof that the UCW rail in `runDealAction` works from
 * the UI: the button must NOT ask for a browser wallet, must build a Circle
 * challenge, must open the hosted approval, and must flip the deal afterwards.
 *
 * NOTE: the escrow page needs several seconds to load its deals — the SPA boots,
 * calls /api/auth/me, then refreshes wallet/orders/deals. Sampling too early
 * shows "WL Deals (0)" and looks like a rendering bug when it is only latency.
 *
 * Usage:
 *   node scripts/tools/wl-ui-action.mjs --session .secrets/ucw-<x>.json \
 *     --deal <uuid> --button "Mark as Delivered" --pin 123456
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
const buttonLabel = arg("button", "Mark as Delivered");
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

// The buyer's actions go through `window.confirm(...)` (see confirmReceiptDeal /
// disputeDeal in app.jsx). Playwright DISMISSES dialogs by default, so confirm()
// returns false, the handler bails out, and no Circle iframe ever mounts — which
// looks exactly like a broken button. Accept them instead.
page.on("dialog", (d) => d.accept().catch(() => {}));

const notes = [];
page.on("console", (m) => {
  const t = m.text().replace(/\s+/g, " ");
  if (/wallet|ucw|challenge|deliver|action|failed/i.test(t)) notes.push(t.slice(0, 150));
});
page.on("response", async (r) => {
  const u = r.url();
  if (/action-challenge|mark-delivered|confirm-receipt|refund|cancel|escape-hatch|proceed/.test(u)) {
    let b = "";
    try { b = (await r.text()).slice(0, 170); } catch {}
    log(r.ok(), `${r.status()} ${u.replace(BASE, "")}`, b);
  }
});

await page.goto(`${BASE}/escrow/${dealId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });

// Wait for the ACTUAL deal room — the page chrome alone is >400 chars, so a
// length check exits before the room mounts and the buttons look missing.
let count = 0;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  if (txt.includes(dealId.slice(0, 8)) && !/Loading deal/.test(txt)) { count = 1; break; }
}
log(count > 0, "deal room rendered");

const btn = page.getByRole("button", { name: new RegExp(buttonLabel, "i") }).first();
const hasBtn = (await btn.count()) > 0;
log(hasBtn, `button "${buttonLabel}" present`);
if (hasBtn) {
  await btn.click({ timeout: 10_000 }).catch((e) => log(false, "click failed", String(e).slice(0, 100)));

  // The UCW rail must NOT ask for an external wallet.
  const sawWalletPrompt = await page
    .getByText(/connect your wallet/i)
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  log(!sawWalletPrompt, sawWalletPrompt ? "asked for an external wallet (UCW rail NOT taken)" : "no external-wallet prompt");

  await page.waitForFunction(() => !!document.getElementById("sdkIframe"), { timeout: 30_000 }).catch(() => {});

  for (let round = 1; round <= 12; round++) {
    const frames = page.frames().filter((f) => /pw-auth\.circle\.com/.test(f.url()));
    if (!frames.length) { log(null, `round ${round}: no Circle frame`); await page.waitForTimeout(2500); continue; }
    const fr = frames[0];
    let t = "";
    try { t = (await fr.locator("body").innerText({ timeout: 5000 })).replace(/\s+/g, " ").trim(); } catch {}
    log(null, `round ${round}: ${fr.url().replace("https://pw-auth.circle.com", "…")} — "${t.slice(0, 60)}"`);

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

await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(SHOT_DIR, "wl-ui-delivered.png"), fullPage: true }).catch(() => {});

const after = await page.evaluate(async (id) => {
  const r = await fetch(`/api/wl/deals/${id}`, { credentials: "include" });
  return r.ok ? await r.json() : null;
}, dealId);
// markDelivered sets deliveredAt; confirmEscrow closes the deal (COMPLETED);
// flagDispute moves it to DISPUTED; cancel sets CANCELLED. Accept any of them.
const applied = after?.deliveredAt != null
  || after?.status === "COMPLETED"
  || after?.status === "DISPUTED"
  || after?.status === "CANCELLED";
log(applied, "action applied", `status=${after?.status} delivered=${after?.deliveredAt != null}`);

if (notes.length) console.log("\nconsole:\n  " + notes.slice(0, 8).join("\n  "));
await browser.close();
console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
