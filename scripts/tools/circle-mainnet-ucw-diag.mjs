#!/usr/bin/env node
/**
 * circle-mainnet-ucw-diag.mjs — end-to-end probe of the Circle MAINNET UCW
 * wallet-creation path, entirely server-side (no browser, no OTP).
 *
 * WHY THIS EXISTS
 * ---------------
 * Mainnet users log in fine but end up with "Wallet Address Not available" and
 * Circle Console shows zero wallets. That means the `initialize` → challenge →
 * wallet chain is broken somewhere. This script walks the whole chain with the
 * PIN auth method (which needs no OTP) so we can see EXACTLY which step fails:
 *
 *   1. POST /v1/w3s/users          — create/reuse a Circle user
 *   2. POST /v1/w3s/users/token    — mint a userToken (server-side, no OTP)
 *   3. POST /v1/w3s/user/initialize — ask Circle for a wallet-creation challenge
 *   4. GET  /v1/w3s/wallets        — see what wallets exist
 *
 * Step 3 is the money question: if Circle rejects `blockchains: ["ARC"]` +
 * `accountType: "EOA"` we get a clear error code instead of a silent blank
 * hosted UI in the browser.
 *
 * NOTE: `initialize` only CREATES A CHALLENGE — it does not create a wallet and
 * does not bill. The wallet is only created when a user executes the challenge
 * (PIN in Circle's hosted UI). So this probe is safe to run on mainnet.
 *
 * Usage:
 *   node --env-file=.env.production scripts/tools/circle-mainnet-ucw-diag.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");

function loadEnv(file) {
  const out = {};
  const p = path.join(REPO, file);
  if (!existsSync(p)) return out;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[0] === v.at(-1))
      v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

const env = loadEnv(".env.production");
const API_KEY = env.CIRCLE_API_KEY;
const BLOCKCHAIN = env.CIRCLE_BLOCKCHAIN || "ARC";
const ACCOUNT_TYPE = env.CIRCLE_UCW_ACCOUNT_TYPE || "EOA";
const BASE = "https://api.circle.com";

if (!API_KEY) {
  console.error("CIRCLE_API_KEY missing from .env.production");
  process.exit(2);
}

// Unique throwaway user id for this probe run.
const USER_ID = "diag" + randomBytes(6).toString("hex");

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}
function ok(msg) {
  console.log(`    \u2713 ${msg}`);
}
function bad(msg) {
  console.log(`    \u2717 ${msg}`);
}

async function circle(pathname, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, raw, json };
}

console.log("\nCircle MAINNET UCW wallet-creation probe");
console.log("=".repeat(58));
console.log(`blockchain=${BLOCKCHAIN}  accountType=${ACCOUNT_TYPE}`);
console.log(`probe userId=${USER_ID}\n`);

// --- 1. create user -------------------------------------------------------
step(1, "POST /v1/w3s/users  (create a Circle user)");
{
  const { status, json, raw } = await circle("/v1/w3s/users", {
    method: "POST",
    body: { userId: USER_ID },
  });
  if (status >= 400) {
    bad(`create user failed: HTTP ${status} ${raw.slice(0, 300)}`);
    process.exit(1);
  }
  ok(`user created (id=${json?.data?.user?.id ?? "?"})`);
}

// --- 2. user token --------------------------------------------------------
step(2, "POST /v1/w3s/users/token  (server-side userToken — no OTP)");
let userToken;
{
  const { status, json, raw } = await circle("/v1/w3s/users/token", {
    method: "POST",
    body: { userId: USER_ID },
  });
  if (status >= 400 || !json?.data?.userToken) {
    bad(`token failed: HTTP ${status} ${raw.slice(0, 300)}`);
    process.exit(1);
  }
  userToken = json.data.userToken;
  ok("userToken acquired");
}

// --- 3. initialize (the wallet-creation challenge) ------------------------
step(3, `POST /v1/w3s/user/initialize  (blockchains=[${BLOCKCHAIN}], ${ACCOUNT_TYPE})`);
{
  const { status, json, raw } = await circle("/v1/w3s/user/initialize", {
    method: "POST",
    headers: { "X-User-Token": userToken },
    body: {
      idempotencyKey: randomUUID(),
      accountType: ACCOUNT_TYPE,
      blockchains: [BLOCKCHAIN],
    },
  });

  const code = json?.code;
  if (json?.data?.challengeId) {
    ok(`challengeId=${json.data.challengeId}`);
    console.log("\n    \u2192 initialize ACCEPTED. The challenge must now be executed");
    console.log("      in Circle's hosted UI (user PIN) to actually create the wallet.");
    console.log("      If the hosted UI renders blank, the problem is browser-side");
    console.log("      (SDK/iframe handshake), NOT this API call.");
  } else if (code === 155106) {
    ok("155106 — user already initialized (no challenge needed)");
  } else {
    bad(`initialize FAILED: HTTP ${status} code=${code}`);
    console.log("    " + raw.slice(0, 500));
    console.log("\n    \u2192 Circle rejected this chain/accountType combination.");
    console.log("      This is why no wallet is ever created on mainnet.");
  }
}

// --- 4. list wallets ------------------------------------------------------
step(4, "GET /v1/w3s/wallets  (what wallets exist for this user)");
{
  const { status, json, raw } = await circle("/v1/w3s/wallets", {
    headers: { "X-User-Token": userToken },
  });
  const wallets = json?.data?.wallets ?? [];
  if (status >= 400) {
    bad(`list failed: HTTP ${status} ${raw.slice(0, 300)}`);
  } else if (wallets.length === 0) {
    ok("no wallets yet (expected — challenge not executed)");
  } else {
    for (const w of wallets) {
      console.log(`    \u2713 ${w.id}  ${w.address}  ${w.blockchain}  ${w.state}`);
    }
  }
}

console.log("\n" + "-".repeat(58) + "\n");
