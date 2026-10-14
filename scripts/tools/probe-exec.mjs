#!/usr/bin/env node
/**
 * probe-exec.mjs — watch Circle's execute() end-to-end inside the real page.
 *
 * The on-chain checkout stalls at `executeUcwChallenge(challengeId)` — the SDK
 * promise never settles and no iframe appears, even though /challenge returned
 * 201. This probe injects listeners BEFORE the app loads so we can see:
 *   - whether #sdkIframe is appended, and its src
 *   - whether the frame receives messages from pw-auth.circle.com
 *   - whether `message` events reach window at all
 *   - what happened to the execute promise after N seconds
 *
 * Usage: node scripts/tools/probe-exec.mjs --session .secrets/ucw-x.json
 */

import { chromium } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = "http://localhost:3000";
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const s = JSON.parse(readFileSync(path.join(REPO, arg("session", ".secrets/ucw-testsellerxnzwo.json")), "utf8"));
const statePath = path.join(REPO, s.storageStatePath);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext(existsSync(statePath) ? { storageState: statePath } : {});
const page = await ctx.newPage();

// Instrument BEFORE any app script runs.
await page.addInitScript(() => {
  window.__log = [];
  const rec = (m) => { window.__log.push(m); };
  // Watch iframe insertion + src changes.
  const mo = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const n of mu.addedNodes) {
        if (n.tagName === "IFRAME") rec(`iframe appended: id=${n.id} src=${String(n.src).slice(0, 110)} display=${n.style.display}`);
      }
    }
  });
  document.addEventListener("DOMContentLoaded", () => mo.observe(document.body, { childList: true, subtree: true }));
  // Watch postMessage traffic.
  window.addEventListener("message", (e) => {
    const d = e.data;
    const keys = d && typeof d === "object" ? Object.keys(d).slice(0, 6).join(",") : typeof d;
    rec(`message from ${e.origin.slice(0, 40)} keys=[${keys}]`);
  }, false);
  rec("init script installed");
});

page.on("console", (m) => {
  const t = m.text();
  if (/w3s|challenge|ucw|sdkIframe/i.test(t)) console.log("[console]", t.slice(0, 170));
});

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.executeUcwChallenge === "function", { timeout: 45_000 });
console.log("== app loaded ==");

// Create a draft + challenge.
const draft = await page.evaluate(async () => {
  const cat = await (await fetch("/api/products?search=Onchain")).json().catch(() => null);
  const p = (cat?.items ?? []).find((x) => (x.stock ?? 0) > 0) ?? (cat?.items ?? [])[0];
  if (!p) return null;
  const r = await fetch("/api/orders/checkout/prepare", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: p.id, variantLabel: "Default", qty: 1, payment: "Balance" }),
  });
  const j = await r.json();
  return j.orderDraftId ?? j.orderId ?? j.id ?? null;
});
console.log("draft:", draft);
if (!draft) { await browser.close(); process.exit(1); }

const cr = await page.evaluate(async (d) => {
  const r = await fetch("/api/orders/checkout/challenge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderDraftId: d }),
  });
  const j = await r.json();
  return { status: r.status, challengeId: j.challengeId, txId: j.txId, devBypass: !!j.devBypass, err: j.error };
}, draft);
console.log("challenge:", JSON.stringify(cr));

// Fire execute WITHOUT awaiting; log everything for 40s.
await page.evaluate((cid) => {
  window.__execDone = undefined;
  window.executeUcwChallenge(cid)
    .then((r) => { window.__execDone = { ok: true, r }; })
    .catch((e) => { window.__execDone = { ok: false, e: String(e) }; });
}, cr.challengeId);

for (let i = 1; i <= 14; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const snap = await page.evaluate(() => {
    const f = document.getElementById("sdkIframe");
    return {
      done: window.__execDone,
      iframe: f ? { src: String(f.src).slice(0, 120), display: f.style.display, w: f.width, h: f.height } : null,
      frames: window.__log.slice(-8),
    };
  }).catch((e) => ({ err: String(e) }));

  console.log(`\n--- t+${i * 3}s ---`);
  console.log("done:", JSON.stringify(snap.done)?.slice(0, 130));
  console.log("iframe:", JSON.stringify(snap.iframe));
  if (snap.frames) for (const l of snap.frames) console.log("  log:", l.slice(0, 140));
  if (snap.done) break;
}

await page.screenshot({ path: path.join(REPO, ".secrets/shots/probe-exec.png") }).catch(() => {});
await browser.close();
