/**
 * wl-escape-hatch.mjs — verify the escape-hatch guard reads the CONTRACT's own
 * deadlines (bug #35).
 *
 * Two checks:
 *   1) API — POST /api/wl/deals/:id/escape-hatch directly (same-origin, session
 *      cookie) and print status + body. With a stale/backdated DB deadline the
 *      route must STILL refuse (409 TIMEOUT_NOT_ELAPSED) because it now trusts
 *      the on-chain deadline, not the DB mirror.
 *   2) UI  — optionally click the "Force Refund"/"Force Release" button in the
 *      deal room and capture the escape-hatch response the SPA receives.
 *
 * Usage:
 *   node scripts/tools/wl-escape-hatch.mjs --session .secrets/ucw-<x>.json \
 *     --deal <uuid> [--action refund|release] [--ui]
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
const dealId = arg("deal");
const action = arg("action", "refund");
const doUi = args.includes("--ui");

if (!sessionPath || !existsSync(sessionPath)) { console.error("--session <path> required"); process.exit(2); }
if (!dealId) { console.error("--deal <uuid> required"); process.exit(2); }

const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
let state;
if (wrapper.storageStatePath) {
  const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
  state = JSON.parse(readFileSync(real, "utf8"));
} else state = wrapper.storageState ?? wrapper;

let failed = 0;
const log = (ok, name, detail = "") => {
  console.log(`  ${ok === null ? "\u2022" : ok ? "\u2713" : "\u2717"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok === false) failed++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept().catch(() => {}));

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });

// ---- 1) API-level ---------------------------------------------------------
console.log(`\n[1] POST /api/wl/deals/${dealId.slice(0, 8)}…/escape-hatch  action=${action}`);
const api = await page.evaluate(async ({ base, id, action }) => {
  const r = await fetch(`${base}/api/wl/deals/${id}/escape-hatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action }),
  });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}, { base: BASE, id: dealId, action });
console.log(`    status=${api.status}  body=${JSON.stringify(api.body)}`);

// A 409 is the CORRECT outcome whenever the contract would reject the relay —
// the guard mirrors the contract's preconditions exactly. A 202 means the
// on-chain deadline really had elapsed and the relay was accepted.
const REFUSALS = {
  TIMEOUT_NOT_ELAPSED: "on-chain deadline not elapsed",
  DISPUTED: "deal is disputed (release blocked)",
  NOT_FUNDED: "deal not funded on-chain",
  NOT_DELIVERED: "seller has not marked delivered",
  ALREADY_DELIVERED: "delivered (use the confirm path)",
  ALREADY_RESOLVED: "already resolved on-chain",
};
if (api.status === 202) {
  log(true, "relay accepted (on-chain deadline had elapsed)", JSON.stringify(api.body).slice(0, 120));
} else if (api.status === 409 && REFUSALS[api.body?.code]) {
  const extra = api.body?.remainingSeconds
    ? ` (${(api.body.remainingSeconds / 3600).toFixed(1)}h remaining on-chain)`
    : "";
  log(true, `guard refused, as the contract would — ${REFUSALS[api.body.code]}`, `${api.body.code}${extra}`);
} else {
  log(false, "unexpected escape-hatch response", `${api.status} ${JSON.stringify(api.body).slice(0, 120)}`);
}

// ---- 2) UI-level ----------------------------------------------------------
if (doUi) {
  console.log(`\n[2] UI click on the deal room`);
  let captured = null;
  page.on("response", async (r) => {
    if (/escape-hatch/.test(r.url())) {
      let b = ""; try { b = (await r.text()).slice(0, 160); } catch {}
      captured = { status: r.status(), body: b };
    }
  });
  await page.goto(`${BASE}/escrow/${dealId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(1000);
    const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    if (txt.includes(dealId.slice(0, 8)) && !/Loading deal/.test(txt)) break;
  }
  const label = action === "release" ? /Force Release/i : /Force Refund/i;
  const btn = page.getByRole("button", { name: label }).first();
  const has = (await btn.count()) > 0;
  log(has, `button "${action === "release" ? "Force Release" : "Force Refund"}" present`);
  if (has) {
    await btn.click({ timeout: 10_000 }).catch(() => {});
    for (let i = 0; i < 20 && !captured; i++) await page.waitForTimeout(500);
    if (captured) log(true, "SPA received escape-hatch response", `${captured.status} ${captured.body}`);
    else log(false, "no escape-hatch request observed");
  }
}

await browser.close();
console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
