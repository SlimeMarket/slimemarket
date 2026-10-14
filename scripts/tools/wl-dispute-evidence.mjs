/**
 * wl-dispute-evidence.mjs — file a statement on a disputed deal through the real
 * API as a party, then print the refreshed case file.
 *
 * Proves the whole path: route → appendDisputeEvidence → brief regeneration.
 *
 * Usage: node scripts/tools/wl-dispute-evidence.mjs --session .secrets/ucw-<x>.json \
 *          --deal <uuid> --reason "..." [--link https://...]
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
const reason = arg("reason", "Seller minted to a different wallet than the one I funded.");
const link = arg("link");
if (!sessionPath || !existsSync(sessionPath)) { console.error("--session required"); process.exit(2); }
if (!dealId) { console.error("--deal required"); process.exit(2); }

const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
const state = JSON.parse(readFileSync(real, "utf8"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });

const res = await page.evaluate(async ({ id, reason, link }) => {
  const r = await fetch(`/api/wl/deals/${id}/dispute-evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ reason, evidence: [{ note: reason, ...(link ? { link } : {}) }] }),
  });
  return { status: r.status, body: await r.text() };
}, { id: dealId, reason, link });

console.log(`POST dispute-evidence → ${res.status}`);
console.log(res.body.slice(0, 400));

const parsed = (() => { try { return JSON.parse(res.body); } catch { return null; } })();
if (parsed?.disputeBrief) {
  const b = parsed.disputeBrief;
  console.log("\nrefreshed brief:");
  console.log(`  reason     : ${parsed.disputeReason}`);
  console.log(`  buyer      : ${b.claims?.buyer?.length ?? 0} statement(s)`);
  console.log(`  seller     : ${b.claims?.seller?.length ?? 0} statement(s)`);
  console.log(`  release    : ${b.availability?.release?.available}`);
  console.log(`  refund     : ${b.availability?.refund?.available}`);
  console.log(`  slash      : ${b.availability?.slash?.available}`);
  console.log(`  disclaimer : ${b.disclaimer}`);
}

await browser.close();
process.exit(res.status === 201 ? 0 : 1);
