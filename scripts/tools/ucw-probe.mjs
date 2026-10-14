#!/usr/bin/env node
/**
 * ucw-probe.mjs — reconnaissance for the Circle W3SSdk iframe.
 *
 * WHY: `ucw-signup.mjs` proved Circle has NO public REST "verify OTP" endpoint —
 * verification only happens inside Circle's hosted cross-origin iframe, driven
 * by `W3SSdk.verifyOtp()` / `W3SSdk.execute()`. To automate it we must know:
 *   1. what frames appear after `verifyOtp()` is called,
 *   2. the DOM shape inside the Circle frame (input selectors, button labels),
 *   3. whether the frame is same-origin (Playwright can reach it) or
 *      cross-origin (needs `frameLocator` / `page.frames()`).
 *
 * This script answers those questions WITHOUT needing the OTP to be correct —
 * we just render the frame and dump its structure.
 *
 * Usage: node scripts/tools/ucw-probe.mjs --email testseller@slimemarket.app
 */

import { chromium } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const email = arg("email", "testseller@slimemarket.app");

const SHOT_DIR = path.join(REPO, ".secrets", "probe");
mkdirSync(SHOT_DIR, { recursive: true });

function log(...a) { console.log("[probe]", ...a); }

// ---------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

page.on("console", (m) => {
  const t = m.text();
  if (/circle|w3s|otp|iframe|error|fail/i.test(t)) log("console:", t.slice(0, 220));
});
page.on("framenavigated", (f) => log("frame →", f.url().slice(0, 140)));
page.on("request", (r) => {
  const u = r.url();
  if (/circle\.com/.test(u)) log("req  →", r.method(), u.slice(0, 160));
});

log("opening", BASE);
await page.goto(BASE, { waitUntil: "domcontentloaded" });

// The SPA boots from Babel-in-browser; wait for the shell + sign-in affordance.
await page.waitForTimeout(4000);

// Find the sign-in entry. The auth screen can be reached at /auth or /login.
for (const p of ["/auth", "/login", "/signin"]) {
  try {
    await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const has = await page.locator('input[type="email"], input[placeholder*="mail" i]').first().isVisible().catch(() => false);
    if (has) { log("auth screen at", p); break; }
  } catch { /* try next */ }
}

await page.screenshot({ path: path.join(SHOT_DIR, "01-auth.png") });
log("frames after load:", page.frames().length);
for (const f of page.frames()) log("   frame:", f.url().slice(0, 140));

// Dump interactive elements so we know what to click.
const inputs = await page.locator("input").evaluateAll((els) =>
  els.map((e) => ({ type: e.type, name: e.name, id: e.id, ph: e.placeholder, vis: !!e.offsetParent }))
);
log("inputs:", JSON.stringify(inputs, null, 1));

// Try to drive: fill email, click the send/continue button.
const emailBox = page.locator('input[type="email"], input[placeholder*="mail" i]').first();
if (await emailBox.isVisible().catch(() => false)) {
  await emailBox.fill(email);
  log("filled email");

  const btn = page.getByRole("button", { name: /send|code|continue|lanjut|kirim|sign in|login|masuk/i }).first();
  if (await btn.isVisible().catch(() => false)) {
    log("clicking:", (await btn.textContent().catch(() => ""))?.trim());
    await btn.click();
    // Circle iframe mounts asynchronously.
    await page.waitForTimeout(8000);
  } else {
    log("!! no send button found — dumping buttons");
    const btns = await page.locator("button").evaluateAll((els) =>
      els.map((e) => ({ txt: (e.textContent || "").trim().slice(0, 40), vis: !!e.offsetParent }))
    );
    log("buttons:", JSON.stringify(btns, null, 1));
  }
} else {
  log("!! email input not visible");
}

await page.screenshot({ path: path.join(SHOT_DIR, "02-after-send.png"), fullPage: true });

log("frames now:", page.frames().length);
for (const f of page.frames()) {
  log("   frame:", f.url().slice(0, 160));
  // Look for the OTP input inside whichever frame hosts Circle's UI.
  try {
    const n = await f.locator("input").count();
    if (n > 0) {
      const shape = await f.locator("input").evaluateAll((els) =>
        els.map((e) => ({ type: e.type, name: e.name, id: e.id, ph: e.placeholder, max: e.maxLength, vis: !!e.offsetParent }))
      );
      log("   ^ inputs in this frame:", JSON.stringify(shape));
    }
  } catch { /* cross-origin without playwright access */ }
}

log("iframe elements on page:", await page.locator("iframe").count());
for (const fr of await page.locator("iframe").all()) {
  log("   iframe src:", (await fr.getAttribute("src"))?.slice(0, 160), "| title:", await fr.getAttribute("title"));
}

await page.screenshot({ path: path.join(SHOT_DIR, "03-final.png"), fullPage: true });
log("screenshots in", SHOT_DIR);

await browser.close();
