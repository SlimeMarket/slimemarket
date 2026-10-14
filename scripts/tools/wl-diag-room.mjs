/**
 * wl-diag-room.mjs — quick diagnostic: load a deal room with a saved session and
 * dump the session identity, the deal API result, and any client console errors.
 *
 * Usage: node scripts/tools/wl-diag-room.mjs --session .secrets/ucw-<x>.json --deal <uuid>
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
const dealId = arg("deal");
const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
const state = JSON.parse(readFileSync(real, "utf8"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 200)));

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });
const me = await page.evaluate(async () => {
  const r = await fetch("/api/auth/me", { credentials: "include" });
  const j = await r.json().catch(() => null);
  return { status: r.status, email: j?.email, id: j?.id, role: j?.role, hasWallet: j?.hasWallet };
});
console.log("me:", JSON.stringify(me));

const deal = await page.evaluate(async (id) => {
  const r = await fetch(`/api/wl/deals/${id}`, { credentials: "include" });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
}, dealId);
console.log("deal api:", JSON.stringify(deal));

await page.goto(`${BASE}/escrow/${dealId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(12000);
const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400));
console.log("room text:", txt);
console.log("console errors:", errs.length ? errs.slice(0, 6) : "(none)");
await browser.close();
