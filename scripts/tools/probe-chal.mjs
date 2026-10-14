#!/usr/bin/env node
/**
 * probe-chal.mjs — diagnose what Circle's W3SSdk.execute() actually does.
 *
 * The on-chain checkout hangs waiting for `executeUcwChallenge` to resolve.
 * This probe fires a real CONTRACT_EXECUTION challenge and then watches, for
 * 40s: how many browser pages/tabs appear, what URLs they load, and whether
 * the SDK promise ever settles. Headed, so a human can also see the UI.
 *
 * Usage: node scripts/tools/probe-chal.mjs --session .secrets/ucw-x.json
 */

import { chromium } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = "http://localhost:3000";
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = path.join(REPO, arg("session", ".secrets/ucw-testsellerxnzwo.json"));
const s = JSON.parse(readFileSync(sessionPath, "utf8"));
const statePath = path.join(REPO, s.storageStatePath);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext(existsSync(statePath) ? { storageState: statePath } : {});
ctx.on("page", (p) => console.log("[ctx] NEW PAGE:", p.url().slice(0, 100)));
const page = await ctx.newPage();
page.on("popup", (p) => console.log("[page] POPUP:", p.url().slice(0, 100)));
page.on("console", (m) => {
  const t = m.text();
  if (/w3s|challenge|ucw/i.test(t)) console.log("[console]", t.slice(0, 160));
});

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.executeUcwChallenge === "function", { timeout: 45_000 });
console.log("helpers ready; cookies:", (await ctx.cookies()).map((c) => c.name).join(","));

// Create a fresh draft + challenge through the app's own API.
const draftId = await page.evaluate(async () => {
  // Reuse any stocked instant product from the seller.
  const cat = await (await fetch("/api/products?search=Onchain")).json().catch(() => null);
  const items = cat?.items ?? [];
  const p = items.find((x) => (x.stock ?? 0) > 0) ?? items[0];
  if (!p) return { error: "no product" };
  const r = await fetch("/api/orders/checkout/prepare", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: p.id, variantLabel: "Default", qty: 1, payment: "Balance" }),
  });
  const j = await r.json();
  return { id: j.orderDraftId ?? j.orderId ?? j.id, err: r.ok ? null : JSON.stringify(j).slice(0, 120) };
});
console.log("draft ->", JSON.stringify(draftId));
if (!draftId.id) { await browser.close(); process.exit(1); }

const cr = await page.evaluate(async (d) => {
  const r = await fetch("/api/orders/checkout/challenge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderDraftId: d }),
  });
  return { status: r.status, body: await r.json() };
}, draftId.id);
console.log("challenge ->", cr.status, JSON.stringify(cr.body).slice(0, 180));
if (!cr.body?.challengeId) { await browser.close(); process.exit(1); }

// Fire the SDK call WITHOUT awaiting, and watch for side effects.
await page.evaluate((cid) => {
  window.__done = null;
  window.executeUcwChallenge(cid).then((r) => { window.__done = { ok: true, r }; }).catch((e) => { window.__done = { ok: false, e: String(e) }; });
}, cr.body.challengeId).catch(() => {});

for (let i = 1; i <= 15; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await page.evaluate(() => ({ done: window.__done, href: location.href })).catch(() => ({}));
  const urls = ctx.pages().map((p) => p.url().replace(BASE, "").slice(0, 70));
  console.log(`t+${i * 3}s done=${JSON.stringify(st.done)?.slice(0, 90)} pages=${ctx.pages().length} :: ${urls.join(" | ")}`);
  if (st.done) break;
}

await browser.close();
