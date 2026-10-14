/**
 * wl-ui-list.mjs — verify a seller can post a listing BELOW 1 USDC through the
 * SPA (regression: the submit button used to require `unitPrice >= 1`).
 *
 * Opens the "Sell WL Spot" modal, fills a 0.5 USDC price, asserts "Publish WL"
 * is ENABLED, then publishes and confirms the listing lands.
 *
 * Usage:
 *   node scripts/tools/wl-ui-list.mjs --session .secrets/ucw-<seller>.json --price 0.5
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
const price = arg("price", "0.5");
const project = arg("project", "UI Sub-1 Test " + Date.now().toString().slice(-5));
if (!sessionPath || !existsSync(sessionPath)) { console.error("--session required"); process.exit(2); }

let failed = 0;
const log = (ok, name, detail = "") => {
  console.log(`  ${ok === null ? "\u2022" : ok ? "\u2713" : "\u2717"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok === false) failed++;
};

const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
const state = JSON.parse(readFileSync(real, "utf8"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept().catch(() => {}));

let created = null;
page.on("response", async (r) => {
  if (/\/api\/wl\/listings$/.test(r.url()) && r.request().method() === "POST") {
    let b = ""; try { b = (await r.text()).slice(0, 200); } catch {}
    created = { status: r.status(), body: b };
  }
});

await page.goto(`${BASE}/escrow`, { waitUntil: "domcontentloaded", timeout: 90_000 });

const sellBtn = page.getByRole("button", { name: /Sell WL Spot|Sell WL|Jual WL/i }).first();
for (let i = 0; i < 40 && !(await sellBtn.count()); i++) await page.waitForTimeout(1000);
log((await sellBtn.count()) > 0, "'Sell WL' button present");
await sellBtn.click({ timeout: 10_000 }).catch(() => {});

const publish = page.getByRole("button", { name: /Publish WL|Terbitkan WL/i }).first();
for (let i = 0; i < 20 && !(await publish.count()); i++) await page.waitForTimeout(500);
log((await publish.count()) > 0, "listing modal opened");

await page.locator('input[placeholder*="Azuki"]').first().fill(project);
await page.locator('input[placeholder*="GTD"]').first().fill("Test Spot");
await page.locator('input[placeholder="USDC"]').first().fill(price);
await page.waitForTimeout(500);

const enabled = await publish.isEnabled().catch(() => false);
log(enabled, `"Publish WL" ENABLED at ${price} USDC`, enabled ? "" : "(still disabled — guard not fixed)");

if (enabled) {
  await publish.click({ timeout: 10_000 }).catch(() => {});
  for (let i = 0; i < 20 && !created; i++) await page.waitForTimeout(500);
  if (created) {
    log(created.status === 201 || created.status === 200, `POST /api/wl/listings → ${created.status}`, created.body.slice(0, 110));
  } else {
    log(false, "no listing-create request observed");
  }
}

await browser.close();
console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
