#!/usr/bin/env node
/**
 * circle-entity-check.mjs — verify the Circle App ID / entity config actually
 * registered for the CURRENT API key's environment (testnet vs mainnet).
 *
 * WHY: a blank Circle hosted UI (pw-auth.circle.com renders its skeleton and
 * never hydrates) is almost always error 155114 — "Provided app ID is not
 * recognized in the system". Circle issues a SEPARATE App ID per environment,
 * so a testnet App ID silently produces an unauthenticated, blank iframe when
 * the backend is pointed at mainnet.
 *
 * Usage:
 *   node --env-file=.env.production scripts/tools/circle-entity-check.mjs
 */
import { readFileSync, existsSync } from "node:fs";
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

const env = loadEnv(process.env.ENV_FILE || ".env.production");
const API_KEY = env.CIRCLE_API_KEY;
const CONFIGURED_APP_ID = env.CIRCLE_APP_ID;

if (!API_KEY) {
  console.error("CIRCLE_API_KEY missing from env file");
  process.exit(2);
}

console.log("Checking Circle entity config for this API key...\n");
console.log(`  env file:          ${process.env.ENV_FILE || ".env.production"}`);
console.log(`  CIRCLE_APP_ID:     ${CONFIGURED_APP_ID || "(not set)"}`);
console.log(`  CIRCLE_BLOCKCHAIN: ${env.CIRCLE_BLOCKCHAIN || "(not set)"}`);
console.log(`  ARC_CHAIN_ID:      ${env.ARC_CHAIN_ID || "(not set)"}\n`);

const res = await fetch("https://api.circle.com/v1/w3s/config/entity", {
  method: "GET",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "application/json",
  },
});

const raw = await res.text();
let json = null;
try {
  json = JSON.parse(raw);
} catch {
  /* non-JSON */
}

console.log(`  HTTP ${res.status}\n`);

if (!res.ok) {
  console.error("  Circle rejected the request:");
  console.error("  " + raw.slice(0, 500));
  process.exit(1);
}

const data = json?.data ?? {};
console.log("  Circle's ACTIVE entity config for this API key:");
console.log("  " + JSON.stringify(data, null, 2).split("\n").join("\n  "));

const liveAppId = data.appId;
console.log("\n" + "-".repeat(60));
if (liveAppId && CONFIGURED_APP_ID && liveAppId !== CONFIGURED_APP_ID) {
  console.log("  *** MISMATCH — this is why the hosted UI is blank ***");
  console.log(`  .env CIRCLE_APP_ID = ${CONFIGURED_APP_ID}`);
  console.log(`  Circle (live)      = ${liveAppId}`);
  console.log("\n  Fix: set CIRCLE_APP_ID to the live value above.");
  console.log("-".repeat(60) + "\n");
  process.exit(1);
} else if (liveAppId) {
  console.log("  MATCH — CIRCLE_APP_ID is valid for this environment.");
  console.log("-".repeat(60) + "\n");
  process.exit(0);
} else {
  console.log("  No appId in response — check the payload above.");
  console.log("-".repeat(60) + "\n");
  process.exit(1);
}
