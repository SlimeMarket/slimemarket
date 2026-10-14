#!/usr/bin/env node
/**
 * probe-exec2.mjs — inspect what Circle's challenge iframe actually renders.
 *
 * probe-exec.mjs proved the iframe DOES load and Circle replies with
 * `onFrameReady` + `showUi`, but never `onComplete` — meaning the hosted UI is
 * waiting for a user interaction that never lands. This probe:
 *   1. fires the challenge
 *   2. dumps the iframe's computed geometry (is it actually on screen?)
 *   3. dumps the iframe's DOM (what screen is it showing?)
 *   4. clicks the first plausible control and re-dumps
 *
 * Usage: node scripts/tools/probe-exec2.mjs --session .secrets/ucw-x.json
 */

import { chromium } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = "http://localhost:3000";
const SHOTS = path.join(REPO, ".secrets", "shots");
mkdirSync(SHOTS, { recursive: true });
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const s = JSON.parse(readFileSync(path.join(REPO, arg("session", ".secrets/ucw-testsellerxnzwo.json")), "utf8"));
const statePath = path.join(REPO, s.storageStatePath);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext(existsSync(statePath) ? { storageState: statePath } : {});
const page = await ctx.newPage();

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.executeUcwChallenge === "function", { timeout: 45_000 });

const draft = await page.evaluate(async () => {
  const cat = await (await fetch("/api/products?search=Onchain")).json().catch(() => null);
  const p = (cat?.items ?? []).find((x) => (x.stock ?? 0) > 0) ?? (cat?.items ?? [])[0];
  const r = await fetch("/api/orders/checkout/prepare", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: p.id, variantLabel: "Default", qty: 1, payment: "Balance" }),
  });
  const j = await r.json();
  return j.orderDraftId ?? j.orderId ?? j.id;
});
const cr = await page.evaluate(async (d) => {
  const r = await fetch("/api/orders/checkout/challenge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderDraftId: d }),
  });
  return await r.json();
}, draft);
console.log("challenge:", cr.challengeId, "devBypass:", !!cr.devBypass);

await page.evaluate((cid) => {
  window.__execDone = undefined;
  window.executeUcwChallenge(cid).then((r) => { window.__execDone = { ok: true, r }; }).catch((e) => { window.__execDone = { ok: false, e: String(e) }; });
}, cr.challengeId);

await page.waitForTimeout(7000);

// 1. geometry of the iframe host
const geo = await page.evaluate(() => {
  const f = document.getElementById("sdkIframe");
  if (!f) return null;
  const r = f.getBoundingClientRect();
  const cs = getComputedStyle(f);
  return { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    display: cs.display, position: cs.position, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity };
});
console.log("iframe geometry:", JSON.stringify(geo));

// 2. what does the frame contain?
const frames = page.frames().filter((f) => /pw-auth\.circle\.com/.test(f.url()));
console.log("circle frames:", frames.length);
for (const fr of frames) {
  console.log(" frame url:", fr.url().slice(0, 110));
  try {
    const txt = await fr.locator("body").innerText({ timeout: 5000 });
    console.log(" frame text:", JSON.stringify(txt.replace(/\s+/g, " ").trim().slice(0, 400)));
    const inputs = await fr.locator("input").evaluateAll((els) => els.map((e) => ({ type: e.type, ph: e.placeholder, max: e.maxLength })));
    console.log(" frame inputs:", JSON.stringify(inputs));
    const btns = await fr.locator("button").evaluateAll((els) => els.map((e) => (e.textContent || "").trim().slice(0, 40)).filter(Boolean));
    console.log(" frame buttons:", JSON.stringify(btns));
  } catch (e) { console.log(" frame read err:", String(e).split("\n")[0].slice(0, 100)); }
}

await page.screenshot({ path: path.join(SHOTS, "exec2-before.png") });

// 3. Try clicking the first enabled button inside the frame.
for (const fr of frames) {
  try {
    const btns = fr.locator("button:not([disabled])");
    const n = await btns.count();
    if (n > 0) {
      const label = (await btns.first().textContent().catch(() => ""))?.trim();
      console.log(`clicking frame button #1: "${label}"`);
      await btns.first().click({ timeout: 6000 });
      break;
    }
  } catch (e) { console.log("click err:", String(e).split("\n")[0].slice(0, 90)); }
}
await page.waitForTimeout(5000);

const after = await page.evaluate(() => window.__execDone);
console.log("after click, done=", JSON.stringify(after)?.slice(0, 140));
for (const fr of page.frames().filter((f) => /pw-auth\.circle\.com/.test(f.url()))) {
  try {
    const txt = await fr.locator("body").innerText({ timeout: 5000 });
    console.log("  frame now:", fr.url().slice(-50), "|", JSON.stringify(txt.replace(/\s+/g, " ").trim().slice(0, 250)));
  } catch {}
}
await page.screenshot({ path: path.join(SHOTS, "exec2-after.png") });
console.log("shots in", SHOTS);
await browser.close();
