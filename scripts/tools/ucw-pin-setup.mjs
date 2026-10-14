#!/usr/bin/env node
/**
 * ucw-pin-setup.mjs — sign in with a REAL Circle session, then drive Circle's
 * hosted "Create PIN + wallet" wizard to completion.
 *
 * WHY
 * ---
 * A brand-new UCW user has credentials but NO wallet and NO PIN. `GET
 * /api/auth/me` detects this (`decideProvisioning` → 'full-challenge') and
 * returns `pinSetupChallengeId`. The app opens Circle's hosted wizard via
 * `W3SSdk.execute(challengeId)` — a multi-step flow: Create PIN → Confirm PIN
 * → 2 security questions. Only after it completes does the wallet exist.
 *
 * This script automates that wizard so downstream checkout has a real wallet.
 *
 * Usage:
 *   node scripts/tools/ucw-pin-setup.mjs --email testseller@slimemarket.app --pin 123456
 */

import { chromium } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);

const email = arg("email");
let PIN = arg("pin", "824613");
if (!email) { console.error("usage: ucw-pin-setup.mjs --email you@x.app [--pin 123456] [--headed]"); process.exit(2); }

// The app enforces "3 OTP requests per hour per email" (app/api/auth/email-otp).
// rimuru@slimemarket.app is a CATCH-ALL, so a unique local part per run gives a
// clean rate-limit bucket while every OTP still lands in the one inbox.
// Use `local<tag>@domain` (not `local+tag@`) — Circle's email validator is
// stricter about RFC 5233 subaddressing than the catch-all is.
// Pass --fixed-email to opt out (e.g. to re-test one specific account).
const FIXED = flag("fixed-email");
const addr = FIXED
  ? email
  : email.replace(/^([^@]+)@/, (_m, local) => `${local}${Date.now().toString(36).slice(-5)}@`);

const SHOT_DIR = path.join(REPO, ".secrets", "shots");
mkdirSync(SHOT_DIR, { recursive: true });

const step = (n, m) => console.log(`\n[${n}] ${m}`);
const ok = (m) => console.log(`    \u2713 ${m}`);
const bad = (m) => console.log(`    \u2717 ${m}`);
const info = (m) => console.log(`    \u2022 ${m}`);

// Read the newest OTP from Spacemail (see ucw-playwright.mjs for the rationale).
function readOtp(sinceSec) {
  // Node cannot spawn child processes in this environment (EBUSY), so when
  // OTP_FROM_FILE is set the caller fetches the code and drops it in a file.
  if (process.env.OTP_FROM_FILE) {
    for (let i = 0; i < 60; i++) {
      try {
        const v = readFileSync(process.env.OTP_FROM_FILE, "utf8").trim();
        if (/^\d{4,8}$/.test(v)) { try { rmSync(process.env.OTP_FROM_FILE); } catch {} return v; }
      } catch {}
      execFileSync ? null : null;
      const until = Date.now() + 2000; while (Date.now() < until) {}
    }
    throw new Error("no OTP file");
  }
  const py = process.env.PYTHON || "python";
  const script = path.join(REPO, "scripts", "tools", "otp-fetch.py");
  let out = "";
  try {
    out = execFileSync(py, [script, "--to", addr, "--since", String(Math.max(0, sinceSec)), "--timeout", "40", "--interval", "4"],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { throw new Error(String(e.stderr ?? e.message).trim().slice(0, 200)); }
  const code = (out.match(/^\s*(\d{4,8})\s*$/m) || [])[1];
  if (!code) throw new Error(`no code in: ${out.slice(0, 200)}`);
  return code;
}

/** Dump every frame's interactive elements — our eyes inside Circle's wizard. */
async function dumpFrames(page, tag) {
  info(`--- frames (${tag}) ---`);
  for (const f of page.frames()) {
    const u = f.url();
    if (!/^https?:/.test(u)) continue;
    let n = 0, shape = [];
    try {
      n = await f.locator("input, button").count();
      shape = await f.locator("input, button").evaluateAll((els) =>
        els.filter((e) => e.offsetParent || e.type === "hidden").map((e) => ({
          tag: e.tagName.toLowerCase(), type: e.type || "", ph: e.placeholder || "",
          txt: (e.textContent || e.value || "").trim().slice(0, 34),
          max: e.maxLength, vis: !!e.offsetParent,
        })));
    } catch { /* detached */ }
    info(`  ${u.slice(0, 100)}  (${n} els)`);
    for (const s of shape.slice(0, 12)) info(`      ${JSON.stringify(s)}`);
  }
}

async function findOtpFrame(page) {
  return page.frames().find((f) => /pw-auth\.circle\.com/.test(f.url()));
}

/** The PIN wizard is any pw-auth frame that is NOT the verify-email step. The
 *  verify-email frame lingers while tearing down right after login, and matching
 *  it in the wizard loop makes the loop think the wizard just closed. */
async function findWizardFrame(page) {
  return page.frames().find(
    (f) => /pw-auth\.circle\.com/.test(f.url()) && !/verify-email/.test(f.url()),
  );
}

/** Type `value` into a frame's OTP-style single-char inputs (or one big input). */
async function typeDigits(frame, value) {
  const boxes = frame.locator('input[type="password"], input[inputmode="numeric"], input[maxlength="1"]');
  const cnt = await boxes.count();
  if (cnt >= value.length) {
    await boxes.first().click();
    await frame.page().keyboard.type(value, { delay: 110 });
    return true;
  }
  const single = frame.locator('input').first();
  if (await single.count()) { await single.fill(value); return true; }
  return false;
}

// ---------------------------------------------------------------------------
console.log(`\nCircle UCW PIN + wallet setup  \u2192  ${addr}\n${"=".repeat(62)}`);
info(`base=${BASE}  pin=${PIN.replace(/./g, "*")}`);

const browser = await chromium.launch({ headless: !flag("headed") });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);

page.on("console", (m) => {
  const t = m.text();
  if (/ucw|w3s|challenge|pin|wallet|circle/i.test(t) && !/Download the React/i.test(t)) info(`console: ${t.slice(0, 170)}`);
});
// Watch the two calls that gate the whole flow: the OTP request and the
// W3SSdk login exchange. If neither fires, the click did not land.
page.on("response", (r) => {
  const u = r.url();
  if (/\/api\/auth\/(email-otp|unified)/.test(u)) info(`HTTP ${r.status()} ${u.replace(BASE, "")}`);
});

// --- 1. sign in (real OTP) -------------------------------------------------
step(1, "sign in with a real Circle OTP");
{
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  info(`after goto url=${page.url()}`);
  const box = page.locator('input[type="email"]').first();
  if (!(await box.isVisible({ timeout: 15_000 }).catch(() => false))) {
    bad("email input not visible — a stale session may have redirected us");
    await dumpFrames(page, "no-email-input");
    await page.screenshot({ path: path.join(SHOT_DIR, "pin-no-email.png"), fullPage: true });
    await browser.close();
    process.exit(1);
  }
  await box.fill(addr);
  const at = Math.floor(Date.now() / 1000);
  // The button is type=submit inside the auth form; click it directly and give
  // the app's OTP-request round trip time to complete before hunting the frame.
  const sendBtn = page.getByRole("button", { name: /send login code|send code|kirim/i }).first();
  await sendBtn.waitFor({ state: "visible", timeout: 20_000 });
  await sendBtn.click({ timeout: 15_000 });
  ok("code requested");
  await page.waitForTimeout(5000);
  info(`after request url=${page.url()} frames=${page.frames().length}`);

  let fr = null;
  const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    fr = await findOtpFrame(page);
    if (fr && /verify-email/.test(fr.url())) {
      try { await fr.locator('input[type="password"]').first().waitFor({ timeout: 5000 }); break; } catch { /* keep polling */ }
    }
    await page.waitForTimeout(1000);
  }
  if (!fr) {
    bad("no Circle OTP frame");
    info(`url=${page.url()}`);
    await dumpFrames(page, "no-otp-frame");
    await page.screenshot({ path: path.join(SHOT_DIR, "pin-no-frame.png"), fullPage: true });
    await browser.close();
    process.exit(1);
  }
  ok("OTP frame mounted");

  let code = null;
  const odl = Date.now() + 150_000;
  while (Date.now() < odl) {
    try { code = readOtp(at); break; } catch { await page.waitForTimeout(7000); }
  }
  if (!code) { bad("no OTP mail"); await browser.close(); process.exit(1); }
  ok(`OTP = ${code}`);

  await typeDigits(fr, code);
  await page.waitForTimeout(3000);

  // Wait until we're past /auth (session established).
  const sdl = Date.now() + 60_000;
  while (Date.now() < sdl) {
    if (!/\/auth/.test(page.url())) break;
    await page.waitForTimeout(1200);
  }
  // New users land on a username step — fill it if shown.
  try {
    const uname = page.locator('input[placeholder*="username" i], input[name="username"]').first();
    if (await uname.isVisible({ timeout: 8000 }).catch(() => false)) {
      const val = addr.split("@")[0].replace(/[^a-z0-9_]/gi, "").slice(0, 18);
      await uname.fill(val);
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: /continue|create|lanjut/i }).first().click().catch(() => {});
      ok(`picked username ${val}`);
    }
  } catch { /* not a new user */ }
  await page.waitForTimeout(3000);
  ok(`session up — ${page.url()}`);
}

// --- 2. wait for the PIN gate ----------------------------------------------
step(2, "wait for the PIN-setup gate");
let gateSeen = false;
{
  const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    const txt = await page.locator("body").innerText().catch(() => "");
    if (/create.*pin|set up.*pin|security question|wallet setup|buat pin/i.test(txt)) { gateSeen = true; break; }
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, "pin-01-gate.png"), fullPage: true });
  if (gateSeen) ok("PIN gate visible"); else info("no PIN gate text yet — proceeding to frame hunt");

  // The gate is a modal with TWO buttons: "Set up my PIN" (runs the Circle
  // wizard) and "Later — pay with your own wallet" (skips). We must click the
  // setup button — the Circle frame only mounts after that click.
  const setupBtn = page.getByRole("button", { name: /set up my pin|set up.*pin|buat pin/i }).first();
  if (await setupBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await setupBtn.click({ timeout: 10_000 });
    ok("clicked 'Set up my PIN' — Circle wizard should mount");
    await page.waitForTimeout(6000);
  } else {
    info("no 'Set up my PIN' button visible — the wizard may already be open");
  }
}

// --- 3. drive Circle's wizard ----------------------------------------------
step(3, "drive Circle's hosted PIN wizard");
{
  await dumpFrames(page, "after gate");

  // The wizard is a sequence of hosted screens. Rather than guessing a fixed
  // order, loop: look at the Circle frame's visible text + inputs, do the one
  // obvious action, repeat until the frame goes away (wizard closed).
  // Wait for the hosted wizard to actually mount before looping. Without this,
  // findOtpFrame() runs while the app still shows "Opening secure setup…", the
  // loop reads "no frame" as "wizard finished", and the run exits having done
  // nothing — which is exactly how the wallet silently stayed uncreated.
  // findOtpFrame matches ANY pw-auth frame — including the verify-email frame
  // that is still tearing down right after login. Treating that as "the wizard"
  // made round 1 see it vanish and declare the wizard finished before the PIN
  // UI had mounted, so the wallet silently stayed uncreated. Wait for a frame
  // that is NOT verify-email AND actually renders inputs.
  let mounted = false;
  for (let i = 0; i < 45; i++) {
    const cand = page.frames().find(
      (f) => /pw-auth\.circle\.com/.test(f.url()) && !/verify-email/.test(f.url()),
    );
    if (cand) {
      let n = 0;
      try { n = await cand.locator("input").count(); } catch {}
      if (n > 0) { mounted = true; break; }
    }
    await page.waitForTimeout(1000);
  }
  if (!mounted) info("Circle wizard frame never mounted — continuing anyway");

  const MAX_ROUNDS = 12;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const fr = await findWizardFrame(page);
    if (!fr) { ok(`round ${round}: Circle frame gone — wizard finished`); break; }

    let body = "";
    try { body = (await fr.locator("body").innerText({ timeout: 6000 })).replace(/\s+/g, " ").trim(); } catch {}
    let nInputs = 0;
    try { nInputs = await fr.locator("input").count(); } catch {}
    info(`round ${round}: inputs=${nInputs} · "${body.slice(0, 110)}"`);

    // a) PIN / confirm-PIN: one or more password-style boxes.
    if (nInputs > 0) {
      let isText = false;
      try {
        isText = await fr.locator('input[type="text"], textarea').count() > 0;
      } catch {}
      if (isText && /question|answer|city|favorite|q\d/i.test(body)) {
        // Security questions — answer each text box.
        const boxes = fr.locator('input[type="text"], textarea');
        const c = await boxes.count();
        for (let i = 0; i < c; i++) await boxes.nth(i).fill(`slime${i + 1}`).catch(() => {});
        info(`answered ${c} security question(s)`);
      } else {
        await typeDigits(fr, PIN);
        info("typed PIN");
      }
      await page.waitForTimeout(2000);
    }

    // b) Advance: Circle's buttons are usually "Continue"/"Confirm"/"Submit";
    //    some steps auto-advance once the input is complete.
    try {
      const go = fr.getByRole("button", { name: /continue|confirm|submit|verify|next|done|agree|accept/i }).first();
      if (await go.isVisible({ timeout: 2500 }).catch(() => false)) {
        await go.click({ timeout: 5000 }).catch(() => {});
        info("clicked continue");
      }
    } catch {}

    await page.screenshot({ path: path.join(SHOT_DIR, `pin-round${round}.png`), fullPage: true }).catch(() => {});
    await page.waitForTimeout(3500);
  }

  await page.screenshot({ path: path.join(SHOT_DIR, "pin-final.png"), fullPage: true }).catch(() => {});
}

// --- 4. confirm the wallet exists ------------------------------------------
step(4, "confirm the wallet was created");
{
  // Reload so the app re-runs /api/auth/me and Circle indexes the new wallet.
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);

  const me = await page.evaluate(async (base) => {
    const r = await fetch(base + "/api/auth/me", { credentials: "include" });
    return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  }, BASE).catch((e) => ({ error: String(e) }));

  const wallet = me?.walletAddress || me?.wallet?.address;
  if (wallet) ok(`wallet address: ${wallet}`);
  else bad(`no wallet yet — me=${JSON.stringify(me).slice(0, 200)}`);
  info(`needsPinSetup=${me?.needsPinSetup} action=${me?.pinSetupAction}`);

  const creds = await page.evaluate(async (base) => {
    const r = await fetch(base + "/api/my/ucw-credentials", { credentials: "include" });
    return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  }, BASE).catch((e) => ({ error: String(e) }));

  const jar = await context.cookies();
  // Circle's W3SSdk mints a deviceId on first use and keeps it in browser
  // storage; a challenge is only valid for the device that created the session.
  // `storageState` captures localStorage + cookies for every origin (including
  // Circle's own), so a later browser can reuse the SAME device identity.
  const statePath = path.join(REPO, ".secrets", `storage-${addr.split("@")[0]}.json`);
  await context.storageState({ path: statePath });

  const out = {
    email: addr, walletAddress: wallet ?? null,
    circleWalletId: creds?.circleWalletId ?? null,
    userToken: creds?.userToken ?? null, encryptionKey: creds?.encryptionKey ?? null,
    // Persist the browser cookie jar: downstream scripts (onchain-checkout.mjs)
    // replay these to act as the same authenticated buyer.
    cookies: jar,
    cookieCount: jar.length,
    storageStatePath: path.relative(REPO, statePath),
    savedAt: new Date().toISOString(),
  };
  const p = path.join(REPO, ".secrets", `ucw-${addr.split("@")[0]}.json`);
  writeFileSync(p, JSON.stringify(out, null, 2));
  ok(`session → ${path.relative(REPO, p)}`);

  console.log("\n---UCW-WALLET---");
  console.log(JSON.stringify({ email: addr, walletAddress: out.walletAddress, circleWalletId: out.circleWalletId }));
  console.log("---END---");
}

await browser.close();
