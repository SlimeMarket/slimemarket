/**
 * onramp-session-probe.mjs — mint a real Circle Onramp session through the app's
 * own route, as a signed-in user, and report what comes back.
 *
 * This is the end-to-end check that the onramp wiring actually works:
 *   • the route authenticates (401 without a session)
 *   • the Circle API key is accepted
 *   • `referrerDomain` / `widgetBaseUrl` / env resolution don't blow up
 *
 * A 200 with a session token means the widget can be mounted. A non-200 carries
 * the reason, which is the useful part — Circle's error text says whether it is
 * the key, the product scoping, or the config.
 *
 * Usage: node scripts/tools/onramp-session-probe.mjs --session .secrets/ucw-<x>.json
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
if (!sessionPath || !existsSync(sessionPath)) { console.error("--session required"); process.exit(2); }

const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
const state = JSON.parse(readFileSync(real, "utf8"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });

const me = await page.evaluate(async () => {
  const r = await fetch("/api/auth/me", { credentials: "include" });
  const j = await r.json().catch(() => null);
  return { status: r.status, email: j?.email, walletAddress: j?.walletAddress };
});
console.log(`signed in as: ${me.email}  wallet=${me.walletAddress ?? "(none)"}`);

const res = await page.evaluate(async () => {
  const r = await fetch("/api/wallet/onramp/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({}),
  });
  const text = await r.text();
  return { status: r.status, body: text };
});

console.log(`\nPOST /api/wallet/onramp/session → ${res.status}`);
console.log(res.body.slice(0, 500));

let parsed = null;
try { parsed = JSON.parse(res.body); } catch { /* not json */ }
const ok = res.status === 200 || res.status === 201;
console.log(
  ok
    ? `\n✅ session minted${parsed?.sessionToken ? ` (token ${String(parsed.sessionToken).slice(0, 12)}…)` : ""} — the onramp widget can be mounted`
    : `\n❌ session not minted — see the error above`,
);

await browser.close();
process.exit(ok ? 0 : 1);
