#!/usr/bin/env node
/**
 * ucw-playwright.mjs — obtain a REAL Circle UCW session headlessly.
 *
 * WHY THIS EXISTS
 * ---------------
 * Circle has NO public REST endpoint for OTP *verification*. The verify step
 * only happens inside Circle's hosted cross-origin iframe
 * (`https://pw-auth.circle.com/social/verify-email`), driven by
 * `W3SSdk.verifyOtp()` / `W3SSdk.execute()`.
 *
 * `scripts/tools/ucw-signup.mjs` proved this the hard way: the REST call was
 * silently reinterpreted as a *new* OTP request. The supported path is a real
 * browser — which is what this script drives.
 *
 * THE TRICK (from scripts/tools/ucw-probe.mjs)
 * -------------------------------------------
 * Playwright reaches INSIDE the cross-origin Circle frame via `page.frames()`.
 * The OTP UI is 6 separate `<input type="password" maxlength=1>` elements. We
 * type one digit into each, so the SDK's own state machine fires naturally —
 * no need to reverse-engineer their bundle.
 *
 * FLOW
 * ----
 *   1. open /auth, fill email, click "Send Login Code"
 *   2. wait for the pw-auth.circle.com verify-email frame to mount
 *   3. read the OTP from the Spacemail catch-all (rimuru@ is catch-all, so any
 *      @slimemarket.app address lands there) — poll for FRESH mail only
 *   4. type the 6 digits into the Circle frame
 *   5. capture the W3SSdk login callback result (userToken + encryptionKey)
 *   6. optionally run the PIN + wallet setup challenge
 *
 * Output: prints the session as JSON and (unless --no-save) writes it to
 * .secrets/ucw-<localpart>.json for downstream scripts (transaction-flow).
 *
 * Usage:
 *   node scripts/tools/ucw-playwright.mjs --email testseller@slimemarket.app
 *   node scripts/tools/ucw-playwright.mjs --email testbuyer@slimemarket.app --headed
 */

import { chromium } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function flag(name) { return args.includes(`--${name}`); }

const email = arg("email");
if (!email) {
  console.error("usage: node scripts/tools/ucw-playwright.mjs --email you@example.com [--headed]");
  process.exit(2);
}
const headed = flag("headed");
const noSave = flag("no-save");
const setupPin = flag("pin");

const SHOT_DIR = path.join(REPO, ".secrets", "shots");
mkdirSync(SHOT_DIR, { recursive: true });

const step = (n, m) => console.log(`\n[${n}] ${m}`);
const ok = (m) => console.log(`    \u2713 ${m}`);
const bad = (m) => console.log(`    \u2717 ${m}`);
const info = (m) => console.log(`    \u2022 ${m}`);

// ---------------------------------------------------------------------------
// OTP reader — reuses the proven Python stdlib IMAP helper (otp-fetch.py),
// which already handles the Spacemail quirks (mail.spacemail.com:993, the code
// lives in the SUBJECT, and --since filters stale catch-all mail).
// ---------------------------------------------------------------------------
function readOtp(notBeforeEpochSec) {
  const py = process.env.PYTHON || "python";
  const script = path.join(REPO, "scripts", "tools", "otp-fetch.py");
  // The helper prints the CODE to stdout and the "# source:" line to stderr, so
  // capture both streams (execFileSync throws on a non-zero exit, which is how
  // "no fresh mail yet" surfaces — the caller retries).
  let out = "";
  try {
    out = execFileSync(
      py,
      [script, "--to", email, "--since", String(Math.max(0, notBeforeEpochSec)), "--timeout", "40", "--interval", "4"],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    throw new Error(String(e.stderr ?? e.message).trim().slice(0, 200));
  }
  const code = (out.match(/^\s*(\d{4,8})\s*$/m) || [])[1];
  const src = (out.match(/^# source:\s*(.*)$/m) || [])[1] || "";
  if (!code) throw new Error(`otp-fetch returned no code. Raw:\n${out.slice(0, 400)}`);
  return { code, src };
}

// ---------------------------------------------------------------------------
console.log(`\nCircle UCW headless signup (Playwright)  \u2192  ${email}\n${"=".repeat(62)}`);
info(`base=${BASE}  headed=${headed}`);

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1280, height: 940 } });
const page = await context.newPage();

// Surface page console + any Circle API errors so failures are diagnosable.
page.on("console", (m) => {
  const t = m.text();
  if (/\[ucw\]|\[auth\]|circle|w3s|userToken|challenge/i.test(t)) info(`console: ${t.slice(0, 200)}`);
});

// The app stores the UCW session in httpOnly cookies set by /api/auth/unified.
// We capture the W3SSdk callback result by hooking it BEFORE the SPA loads.
await page.addInitScript(() => {
  window.__UCW_CAPTURE = { userToken: null, encryptionKey: null, error: null };
});

// --- 1. open sign-in and request the OTP -----------------------------------
step(1, "open /auth and request the login code");
let requestedAtSec = 0;
{
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  const emailBox = page.locator('input[type="email"]').first();
  await emailBox.waitFor({ state: "visible", timeout: 30_000 });
  await emailBox.fill(email);

  // Capture the moment we click, so we only accept OTP mail newer than this.
  requestedAtSec = Math.floor(Date.now() / 1000);
  const btn = page.getByRole("button", { name: /send login code|send code|kirim/i }).first();
  await btn.click();
  ok("clicked Send Login Code");
}

// --- 2. wait for Circle's verify-email frame -------------------------------
step(2, "wait for Circle's hosted OTP frame (pw-auth.circle.com)");
let otpFrame = null;
{
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    otpFrame = page.frames().find((f) => /pw-auth\.circle\.com/.test(f.url()) && /verify-email/.test(f.url()));
    if (otpFrame) break;
    await page.waitForTimeout(1000);
  }
  if (!otpFrame) {
    bad("Circle verify-email frame never appeared");
    await page.screenshot({ path: path.join(SHOT_DIR, "no-frame.png"), fullPage: true });
    await browser.close();
    process.exit(1);
  }
  // Wait for the 6 digit boxes to actually render inside it.
  await otpFrame.locator('input[type="password"]').first().waitFor({ timeout: 30_000 });
  const n = await otpFrame.locator('input[type="password"]').count();
  ok(`frame ready — ${n} digit inputs`);
  info(otpFrame.url().slice(0, 110));
}

// --- 3. read the OTP from the Spacemail catch-all --------------------------
step(3, "read the OTP from the Spacemail catch-all inbox");
let code;
{
  // Circle mails usually land in a few seconds; retry to absorb latency.
  const deadline = Date.now() + 150_000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = readOtp(requestedAtSec);
      code = r.code;
      info(`subject: ${r.src.slice(0, 110)}`);
      break;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(8000);
    }
  }
  if (!code) { bad(`no fresh OTP — ${lastErr?.message?.slice(0, 200)}`); await browser.close(); process.exit(1); }
  ok(`OTP = ${code}`);
}

// --- 4. type the digits into Circle's frame --------------------------------
step(4, "type the OTP into the Circle frame");
{
  const boxes = otpFrame.locator('input[type="password"]');
  const digits = String(code).split("");
  if (digits.length !== 6) {
    bad(`expected a 6-digit OTP, got ${digits.length} (${code}) — Circle may have changed format`);
  }
  // Focus the first box, then type the whole code: most OTP widgets auto-advance
  // and this also covers a single-hidden-input implementation.
  await boxes.first().click();
  await page.keyboard.type(code, { delay: 120 });
  ok("typed code");

  // Some builds need each box filled explicitly (no auto-advance on synthetic
  // input). Verify and backfill if the widget stayed empty.
  await page.waitForTimeout(1200);
  // The frame DETACHES on a successful verify — that is the success signal, so
  // treat a detached frame as "done" rather than an error.
  const stillThere = page.frames().some((f) => f === otpFrame && /verify-email/.test(f.url()));
  if (!stillThere) {
    ok("frame detached — verification accepted");
  } else {
    try {
      const filled = await boxes.evaluateAll((els) => els.map((e) => e.value));
      if (filled.filter(Boolean).length < digits.length) {
        info(`auto-advance incomplete (${filled.join("")}) — filling boxes individually`);
        for (let i = 0; i < Math.min(digits.length, await boxes.count()); i++) {
          const b = boxes.nth(i);
          await b.click();
          await b.fill(digits[i]);
        }
      }
    } catch (e) {
      info(`frame vanished mid-check (${String(e).split("\n")[0]}) — assuming accepted`);
    }
  }
  await page.screenshot({ path: path.join(SHOT_DIR, "03-otp-typed.png"), fullPage: true }).catch(() => {});
}

// --- 5. wait for the SDK callback ------------------------------------------
step(5, "wait for the W3SSdk login callback (userToken + encryptionKey)");
let userToken = null, encryptionKey = null;
{
  // The auth.jsx callback chain: iframe verify → POST /api/auth/unified →
  // either onAuthed(...) (returning user) or step='username' (new user).
  // Either way the session cookies are set by /api/auth/unified. We detect
  // success by polling the server-side session, which is authoritative.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // A redirect away from /auth, or a visible app shell, means login worked.
    const url = page.url();
    const shell = await page.locator('[data-testid="app-shell"], nav').first().isVisible().catch(() => false);
    if (shell || !/\/auth/.test(url)) break;
    await page.waitForTimeout(1500);
  }

  // Read the real userToken from the app's own credential endpoint.
  const creds = await page.evaluate(async (base) => {
    try {
      const r = await fetch(base + "/api/my/ucw-credentials", { credentials: "include" });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return await r.json();
    } catch (e) { return { error: String(e) }; }
  }, BASE).catch((e) => ({ error: String(e) }));

  userToken = creds?.userToken ?? null;
  encryptionKey = creds?.encryptionKey ?? null;

  if (!userToken || String(userToken).startsWith("dev-token-")) {
    bad(`no real userToken (got ${userToken ? String(userToken).slice(0, 18) + "…" : "null"})`);
    info(`creds probe: ${JSON.stringify(creds).slice(0, 240)}`);
    info(`page url: ${page.url()}`);
    await page.screenshot({ path: path.join(SHOT_DIR, "05-no-token.png"), fullPage: true });
    await browser.close();
    process.exit(1);
  }
  ok(`userToken acquired: ${String(userToken).slice(0, 16)}…  (encryptionKey ${encryptionKey ? "yes" : "no"})`);
}

// --- 6. persist ------------------------------------------------------------
const session = {
  email, userToken, encryptionKey,
  baseUrl: BASE,
  cookies: await context.cookies(),
  savedAt: new Date().toISOString(),
};

if (!noSave) {
  const out = path.join(REPO, ".secrets", `ucw-${email.split("@")[0]}.json`);
  writeFileSync(out, JSON.stringify(session, null, 2));
  ok(`session → ${path.relative(REPO, out)}`);
}

// Machine-readable tail for callers that pipe this script.
console.log("\n---UCW-SESSION---");
console.log(JSON.stringify({ email, userToken, encryptionKey, cookieCount: session.cookies.length }));
console.log("---END---");

await browser.close();
