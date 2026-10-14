/**
 * wl-prepare-draft.mjs — create an UNFUNDED WAITING draft deal via the real
 * prepare endpoint (buyer session). Used to test actions that only apply before
 * funding (e.g. the seller's "Decline Order" → cancel).
 *
 * Usage: node scripts/tools/wl-prepare-draft.mjs --session .secrets/ucw-<x>.json --listing <uuid> [--qty 1]
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
const listingId = arg("listing");
const qty = Number(arg("qty", "1"));
if (!sessionPath || !existsSync(sessionPath)) { console.error("--session required"); process.exit(2); }
if (!listingId) { console.error("--listing required"); process.exit(2); }

const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
const state = JSON.parse(readFileSync(real, "utf8"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });

const res = await page.evaluate(async ({ listingId, qty }) => {
  const r = await fetch("/api/wl/deals/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ listingId, qty }),
  });
  return { status: r.status, body: await r.text() };
}, { listingId, qty });

console.log(`prepare → ${res.status}`);
console.log(res.body);
await browser.close();
process.exit(res.status === 201 || res.status === 200 ? 0 : 1);
