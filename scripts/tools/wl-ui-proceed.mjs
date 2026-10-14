/**
 * wl-ui-proceed.mjs — click the SELLER's "Accept & Proceed" button in the SPA.
 *
 * This is the one flow with TWO signatures: `collateral-challenge` (approve) then
 * `proceed-non-custodial` (which returns the depositEscrowCollateral challenge).
 * Driving it from the UI is the only way to prove the app signs BOTH — a script
 * that signs only the approve leaves the DB claiming collateral the contract
 * never received.
 *
 * Usage:
 *   node scripts/tools/wl-ui-proceed.mjs --session .secrets/ucw-<seller>.json \
 *     --deal <uuid> --collateral 0.5 --pin 123456
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");

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

// Count every challenge the app asks the seller to sign.
let challengeCount = 0;
page.on("response", async (r) => {
  const u = r.url();
  if (/collateral-challenge|proceed-non-custodial|collateral-confirm/.test(u)) {
    let b = "";
    try { b = (await r.text()).slice(0, 150); } catch {}
    log(r.ok(), `${r.status()} ${u.replace(BASE, "")}`, b);
    // Both signature steps count: collateral-challenge (approve) and
    // proceed-non-custodial (which returns the deposit challenge).
    if (r.ok() && /collateral-challenge|proceed-non-custodial/.test(u)) challengeCount++;
  }
});

// Go straight to the deal room. Searching the list by id is unreliable — the
// cards render the project name, not the deal id, and several test deals share
// the same project name.
await page.goto(`${BASE}/escrow/${dealId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  if (new RegExp(dealId.slice(0, 8)).test(t)) break;
}
await page.waitForTimeout(3000);
const onRoom = page.url().includes(dealId.slice(0, 8));
log(onRoom, "opened the deal room", page.url().replace(BASE, ""));
const opened = onRoom;

// The seller must enter a collateral amount before Proceed is enabled. The field
// is a plain text input (placeholder "as agreed with the buyer"), not type=number.
const amountInput = page.locator('input[placeholder*="agreed" i], input[placeholder*="collateral" i]').first();
if (await amountInput.count()) {
  await amountInput.click().catch(() => {});
  await amountInput.fill(collateral).catch(() => {});
  await page.waitForTimeout(800);
  log(true, "filled collateral amount", collateral);
} else {
  log(false, "collateral input not found");
}

const btn = page.getByRole("button", { name: /Accept & Proceed|Accept Offer & Proceed|^Proceed$/i }).first();
const hasBtn = (await btn.count()) > 0;
const btnDisabled = hasBtn ? await btn.isDisabled().catch(() => false) : null;
log(hasBtn && !btnDisabled, "proceed button enabled", hasBtn ? `disabled=${btnDisabled}` : "not found");
if (hasBtn) {
  await btn.click({ timeout: 10_000 }).catch((e) => log(false, "click failed", String(e).slice(0, 100)));
  const sawWalletPrompt = await page.getByText(/connect your wallet/i).first().isVisible({ timeout: 3000 }).catch(() => false);
  log(!sawWalletPrompt, sawWalletPrompt ? "asked for an external wallet" : "no external-wallet prompt");

  // Drive up to 3 challenges (approve, deposit, any retry).
  for (let round = 1; round <= 40; round++) {
    const frames = page.frames().filter((f) => /pw-auth\.circle\.com/.test(f.url()));
    if (!frames.length) { await page.waitForTimeout(2500); continue; }
    const fr = frames[0];
    let t = "";
    try { t = (await fr.locator("body").innerText({ timeout: 4000 })).replace(/\s+/g, " ").trim(); } catch {}
    log(null, `round ${round}: "${t.slice(0, 50)}"`);
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
    if (!acted) await page.waitForTimeout(2000);
  }
}

await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(SHOT_DIR, "wl-ui-proceed.png"), fullPage: true }).catch(() => {});
log(challengeCount >= 2, "challenges signed from the UI", `count=${challengeCount}`);

const after = await page.evaluate(async (id) => {
  const r = await fetch(`/api/wl/deals/${id}`, { credentials: "include" });
  return r.ok ? await r.json() : null;
}, dealId);
log(after?.status === "ESCROW", "deal reached ESCROW", `status=${after?.status}`);

await browser.close();
console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
