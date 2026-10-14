/**
 * check-page.mjs — load one SPA route with a saved session and report whether it
 * actually rendered, plus any console/page errors. A targeted alternative to the
 * full ui-smoke sweep when you only changed one page.
 *
 * Usage:
 *   node scripts/tools/check-page.mjs --session .secrets/ucw-<x>.json \
 *     --path /wallet --expect "Balance|Top Up"
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
const routePath = arg("path", "/");
const expect = arg("expect");

let state;
if (sessionPath) {
  if (!existsSync(sessionPath)) { console.error(`session missing: ${sessionPath}`); process.exit(2); }
  const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
  if (wrapper.storageStatePath) {
    const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
    state = JSON.parse(readFileSync(real, "utf8"));
  } else state = wrapper.storageState ?? wrapper;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });

// Force a UI language BEFORE the SPA boots. This is the only way to catch a
// broken i18n KEY rename: `tr(key, 'English fallback')` silently shows the
// fallback when the key is missing, so an English-only check passes while every
// other locale is broken.
const lang = arg("lang");
if (lang) {
  await ctx.addInitScript((l) => { try { localStorage.setItem('slime_lang', l); } catch (e) {} }, lang);
}

const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 160)));

let ok = true;
try {
  await page.goto(`${BASE}${routePath}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
} catch (e) {
  console.log(`✗ navigation failed: ${String(e).slice(0, 120)}`);
  ok = false;
}

if (ok) {
  // Give the SPA time to boot, resolve auth, and mount the view.
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    if (expect && new RegExp(expect, "i").test(t)) break;
    if (!expect && t.length > 400) break;
  }
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  console.log(`URL     : ${page.url()}`);
  console.log(`rendered: ${text.slice(0, 220)}`);

  if (expect) {
    const hit = new RegExp(expect, "i").test(text);
    console.log(`${hit ? "✓" : "✗"} expected /${expect}/ ${hit ? "found" : "NOT FOUND"}`);
    ok = hit;
  }
  const realErrs = errs.filter((e) => !/favicon|503 \(Service Unavailable\)/.test(e));
  console.log(`console : ${realErrs.length ? realErrs.slice(0, 4).join(" | ") : "(clean)"}`);
}

await browser.close();
console.log(ok ? "\nOK" : "\nFAILED");
process.exit(ok ? 0 : 1);
