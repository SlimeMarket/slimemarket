#!/usr/bin/env node
/**
 * ucw-signup.mjs — provisions a REAL Circle User-Controlled Wallet for a
 * SlimeMarket account, headlessly, over the public API. No browser iframe.
 *
 * WHY THIS EXISTS
 * ---------------
 * The web UI completes email-OTP login inside a Circle-hosted cross-origin
 * iframe (`W3SSdk.execute`). That is great UX but hostile to automation, and
 * `POST /api/auth/dev-login` deliberately mints a FAKE token (`dev-token-*`)
 * which Circle rejects with "The userToken is invalid." — so on-chain checkout
 * can never be exercised from a dev-login session.
 *
 * Circle's UCW REST API exposes the same steps the iframe performs:
 *   1. POST /v1/w3s/users/email/token      → deviceToken + otpToken (sends OTP mail)
 *   2. POST /v1/w3s/users/email/token      (with otp)      → userToken + encryptionKey
 *   3. POST /v1/w3s/user/initialize        → challengeId (wallet creation)
 *   4. POST /v1/w3s/user/challenges/{id}   → PIN setup + execute, via `circle` CLI
 *
 * Steps 1–3 are plain REST. Step 4 requires the user's PIN to sign challenges
 * (that is the whole point of a *user-controlled* wallet) — so this script
 * STOPS after step 3 and prints the challengeId. Completing it needs either the
 * Circle `circle` CLI or the browser iframe.
 *
 * The OTP is read from the Spacemail catch-all inbox via scripts/tools/otp-fetch.py.
 *
 * Usage:
 *   node scripts/tools/ucw-signup.mjs --email testseller@slimemarket.app
 *   node scripts/tools/ucw-signup.mjs --email testseller@slimemarket.app --imei <uuid>
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const CIRCLE_API = "https://api.circle.com";

// ---- env ------------------------------------------------------------------
function loadEnvLocal() {
  const out = {};
  const p = path.join(REPO, ".env.local");
  if (!existsSync(p)) return out;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[0] === v.at(-1)) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

const env = loadEnvLocal();
const API_KEY = env.CIRCLE_API_KEY;
if (!API_KEY) {
  console.error("CIRCLE_API_KEY missing from .env.local");
  process.exit(2);
}
const BLOCKCHAIN = env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET";

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const email = arg("email");
if (!email) {
  console.error("usage: node scripts/tools/ucw-signup.mjs --email you@example.com");
  process.exit(2);
}
const deviceId = arg("device", randomUUID());

// ---- helpers --------------------------------------------------------------
/**
 * Circle REST call via node:https.
 *
 * NOTE on transport choice — this environment blocks both alternatives:
 *   - global fetch to api.circle.com returns nothing
 *   - `spawnSync("curl", …)` fails with EBUSY on Windows
 * `node:https` with an explicit agent is the one transport that works, and it
 * keeps the Circle API key in-process (never argv, never a temp file on disk).
 */
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

function circle(pathname, { method = "GET", body, headers = {} } = {}) {
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const reqHeaders = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "application/json",
    ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
    ...headers,
  };

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.circle.com",
        path: pathname,
        method,
        headers: reqHeaders,
        timeout: 60_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON error page */ }
          resolve({ status: res.statusCode, raw, json });
        });
      },
    );
    req.on("timeout", () => { req.destroy(new Error("circle request timed out")); });
    req.on("error", (e) => resolve({ status: "?", raw: `transport error: ${e.message}`, json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Redact anything that looks like a bearer token before printing. */
function scrub(s) {
  return String(s ?? "").replace(/Bearer\s+\S+/gi, "Bearer <redacted>");
}

// ---- IMAP (pure Node) -----------------------------------------------------

/**
 * Minimal IMAP client — enough to read the newest OTP mail from the Spacemail
 * catch-all inbox. Written by hand because `imapflow`/`mailparser` are not in
 * package.json and spawning python/curl from Node is blocked here (EBUSY).
 *
 * Spacemail serves IMAP on the SAME hostname as SMTP (mail.spacemail.com:993).
 * There is no `imap.spacemail.com` record.
 */
const IMAP_HOST = process.env.IMAP_HOST || env.IMAP_HOST || "mail.spacemail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || env.IMAP_PORT || 993);

function imapSession() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: IMAP_HOST, port: IMAP_PORT, servername: IMAP_HOST }, () => {
      let buf = "";
      const pending = []; // { tag, resolve, reject, lines }
      let tag = 0;

      sock.on("data", (d) => {
        buf += d.toString("utf8");
        for (;;) {
          const nl = buf.indexOf("\r\n");
          if (nl < 0) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);

          const wait = pending[0];
          if (!wait) continue;
          wait.lines.push(line);
          if (line.startsWith(wait.tag + " ")) {
            pending.shift();
            wait.resolve({ line, lines: wait.lines });
          }
        }
      });

      sock.on("close", () => pending.forEach((p) => p.reject(new Error("imap closed"))));
      sock.on("error", reject);

      const cmd = (command) =>
        new Promise((res, rej) => {
          const t = `a${String(++tag).padStart(4, "0")}`;
          pending.push({ tag: t, resolve: res, reject: rej, lines: [] });
          sock.write(`${t} ${command}\r\n`);
        });

      resolve({ cmd, sock, end: () => sock.end() });
    });
    sock.on("error", reject);
  });
}


/**
 * Poll the catch-all inbox until a mail addressed to `to` arrives, then return
 * the OTP.
 *
 * IMPORTANT: Circle puts the code in the SUBJECT
 * ("[Testing Email] {SE2-663794} is your login code for {company name}"), so we
 * parse headers only and never need to download the message body. That makes
 * this both faster and immune to MIME/HTML-encoding quirks.
 *
 * `notBefore` (epoch ms) is REQUIRED in practice: the mailbox is a long-lived
 * catch-all that already contains OTPs from previous runs. Circle rejects an
 * OTP that does not belong to the otpToken we just requested ("verify failed"),
 * so we must ignore anything older than this request.
 */
async function fetchOtpFromSpacemail(to, timeoutMs, notBefore = 0) {
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  if (!user || !pass) throw new Error("SMTP_USER / SMTP_PASS missing from .env.local");

  const { cmd, end } = await imapSession();
  const login = await cmd(`LOGIN ${JSON.stringify(user)} ${JSON.stringify(pass)}`);
  if (!/ OK/i.test(login.line)) throw new Error("IMAP LOGIN failed (check SMTP_USER / SMTP_PASS)");
  await cmd("SELECT INBOX");

  const target = to.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  // Prefer a code that sits in braces or follows a keyword; else any 4-8 digit run.
  const reCtx = /(?:code|otp|verification|verify|pin|kode|verifikasi)[^0-9]{0,20}(\d{4,8})|[{[]\s*[A-Z]{0,3}-?(\d{4,8})\s*[}\]]/i;
  const reAny = /(?<!\d)(\d{4,8})(?!\d)/;
  let sawStaleOnly = false;

  try {
    while (Date.now() < deadline) {
      const seq = await cmd("SEARCH ALL");
      const nums = (seq.lines.join(" ").match(/\* SEARCH ([0-9 ]*)/)?.[1] ?? "")
        .trim().split(/\s+/).filter(Boolean);
      // Newest first — a fresh OTP is always at the tail.
      for (const n of nums.slice(-30).reverse()) {
        const hdr = await cmd(`FETCH ${n} BODY.PEEK[HEADER.FIELDS (TO SUBJECT DATE FROM)]`);
        const headers = hdr.lines.join("\n");
        const lower = headers.toLowerCase();
        if (!lower.includes(target)) continue;

        const subject = headers.match(/^Subject:\s*(.*)$/im)?.[1] ?? "";
        const dateStr = (headers.match(/^Date:\s*(.*)$/im)?.[1] ?? "").trim();
        const sentAt = Date.parse(dateStr);
        const m = subject.match(reCtx) || subject.match(reAny);
        if (!m) continue;

        // Ignore OTP mail that predates this request — its code is bound to an
        // older otpToken and Circle will reject it.
        if (notBefore > 0 && Number.isFinite(sentAt) && sentAt < notBefore - 5_000) {
          sawStaleOnly = true;
          continue;
        }

        const code = m[1] ?? m[2] ?? m[0];
        console.log(`    \u2713 mail at ${dateStr || "?"} — subject ${JSON.stringify(subject.trim())}`);
        return code;
      }
      await new Promise((r) => setTimeout(r, 6000));
    }
  } finally {
    try { await cmd("LOGOUT"); } catch { /* ignore */ }
    end();
  }
  throw new Error(
    sawStaleOnly
      ? `only STALE OTP mail found for ${to} (all predate this request) — did the new mail get filtered?`
      : `no OTP mail for ${to} within ${Math.round(timeoutMs / 1000)}s`,
  );
}

function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function ok(msg) { console.log(`    \u2713 ${msg}`); }
function bad(msg) { console.log(`    \u2717 ${msg}`); }

// ---------------------------------------------------------------------------
console.log(`\nCircle UCW headless signup  →  ${email}\n${"=".repeat(58)}`);
console.log(`chain=${BLOCKCHAIN}  device=${deviceId}`);

// --- 1. request OTP --------------------------------------------------------
step(1, "POST /v1/w3s/users/email/token  (sends OTP to the mailbox)");
let deviceToken, deviceEncryptionKey, otpToken;
const otpRequestedAt = Date.now();
{
  const { raw, json } = await circle("/v1/w3s/users/email/token", {
    method: "POST",
    body: { idempotencyKey: randomUUID(), deviceId, email },
  });
  if (!json?.data?.deviceToken) { bad(`failed: HTTP ${json?.status ?? "?"} ${scrub(raw).slice(0, 300)}`); process.exit(1); }
  deviceToken = json.data.deviceToken;
  deviceEncryptionKey = json.data.deviceEncryptionKey;
  otpToken = json.data.otpToken;
  ok("deviceToken + otpToken issued");
}

// --- 2. read OTP from Spacemail -------------------------------------------
step(2, "read the OTP from the Spacemail catch-all inbox");
let otp;
{
  try {
    otp = await fetchOtpFromSpacemail(email, 180_000, otpRequestedAt);
  } catch (e) {
    bad(`could not read OTP — ${e.message}`);
    process.exit(1);
  }
  if (!/^\d{4,8}$/.test(String(otp))) { bad(`unexpected OTP payload: ${JSON.stringify(otp)}`); process.exit(1); }
  ok(`OTP = ${otp}`);
}

// --- 3. verify OTP → userToken --------------------------------------------
step(3, "POST /v1/w3s/users/email/token  (exchange OTP for userToken)");
let userToken, encryptionKey, refreshToken;
{
  const { raw, json } = await circle("/v1/w3s/users/email/token", {
    method: "POST",
    body: {
      idempotencyKey: randomUUID(),
      deviceId,
      email,
      deviceToken,
      deviceEncryptionKey,
      otpToken,
      otp,
    },
  });
  const d = json?.data;
  if (!d?.userToken) { bad(`verify failed: HTTP ${json?.status ?? "?"} ${scrub(raw).slice(0, 400)}`); process.exit(1); }
  userToken = d.userToken;
  encryptionKey = d.encryptionKey;
  refreshToken = d.refreshToken;
  ok("userToken + encryptionKey acquired (REAL Circle session)");
}

// --- 4. initialize the wallet ---------------------------------------------
step(4, "POST /v1/w3s/user/initialize  (create the ARC-TESTNET wallet)");
let challengeId = null;
{
  const { raw, json } = await circle("/v1/w3s/user/initialize", {
    method: "POST",
    headers: { "X-User-Token": userToken },
    body: { idempotencyKey: randomUUID(), accountType: "EOA", blockchains: [BLOCKCHAIN] },
  });
  if (json?.code === 155106) {
    ok("wallet already initialized (idempotent)");
  } else if (json?.data?.challengeId) {
    challengeId = json.data.challengeId;
    ok(`challengeId = ${challengeId}`);
  } else {
    bad(`initialize failed: HTTP ${json?.status ?? "?"} ${scrub(raw).slice(0, 400)}`);
  }
}

// --- 5. inspect wallets ---------------------------------------------------
step(5, "GET /v1/w3s/wallets  (list the user's wallets)");
{
  const { raw, json } = await circle("/v1/w3s/wallets", { headers: { "X-User-Token": userToken } });
  const wallets = json?.data?.wallets ?? [];
  if (wallets.length === 0) {
    ok("no wallet yet — the initialize challenge above has not been signed (needs PIN)");
  } else {
    for (const w of wallets) console.log(`    \u2713 ${w.id}  ${w.address}  ${w.blockchain}  ${w.state}`);
  }
}

// --- persist the session for later steps ----------------------------------
const out = path.join(REPO, ".secrets", `ucw-${email.split("@")[0]}.json`);
try {
  writeFileSync(
    out,
    JSON.stringify({ email, userToken, encryptionKey, refreshToken, challengeId, deviceId, savedAt: new Date().toISOString() }, null, 2),
  );
  ok(`session written to ${path.relative(REPO, out)} (gitignored via .secrets/)`);
} catch (e) {
  bad(`could not persist session: ${e.message}`);
}

console.log(`\n${"-".repeat(58)}`);
if (challengeId) {
  console.log("NEXT STEP (needs the user's PIN):");
  console.log(`  complete the initialize challenge ${challengeId} with the Circle`);
  console.log("  `circle` CLI or the browser iframe (W3SSdk.execute).");
} else {
  console.log("Wallet already initialized — the session is ready for on-chain checkout.");
}
console.log(`${"-".repeat(58)}\n`);
