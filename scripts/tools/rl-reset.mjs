#!/usr/bin/env node
/**
 * rl-reset.mjs — clear Upstash rate-limit counters for local e2e runs.
 *
 * WHY: `POST /api/auth/email-otp` enforces "3 OTP requests per hour per email"
 * (app/api/auth/email-otp/route.ts) via an Upstash sliding window. Repeated
 * local e2e runs exhaust it and every later sign-in fails with 429 — which
 * looks like "the iframe never appeared" rather than a rate limit.
 *
 * Keys live under `sm:rl:<subject>[:<endpoint>]:<windowStartMs>`.
 *
 * Usage:
 *   node scripts/tools/rl-reset.mjs --subject testseller@slimemarket.app
 *   node scripts/tools/rl-reset.mjs --all-rl       # every sm:rl:* key
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");

const env = {};
{
  const p = path.join(REPO, ".env.local");
  if (existsSync(p)) {
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith("#") || !l.includes("=")) continue;
      const i = l.indexOf("=");
      env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
  }
}
const URL_ = env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!URL_ || !TOKEN) { console.error("UPSTASH_REDIS_REST_URL / _TOKEN missing from .env.local"); process.exit(2); }

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const subject = arg("subject");
const all = args.includes("--all-rl");
// --ip clears the middleware's per-IP bucket (prefix `sm:rl:ip`, 100 req/min).
// Playwright sign-in runs (Babel-in-browser recompiles + many API calls) can
// exceed that in a single minute and the resulting 429 looks like "the Circle
// iframe never mounted".
const ipMode = args.includes("--ip");
const ip = arg("ip", "::1");

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

const pattern = all ? "sm:rl:*"
  : ipMode ? `sm:rl:ip:*${ip}*`
  : `sm:rl:*${subject}*`;
const { result: keys = [] } = await redis(["KEYS", pattern]);
if (!keys.length) { console.log(`no keys matching ${pattern}`); process.exit(0); }

let n = 0;
for (const k of keys) {
  const { result } = await redis(["DEL", k]);
  n += Number(result) || 0;
  console.log(`deleted ${k}`);
}
console.log(`\n${n} rate-limit key(s) cleared (${pattern})`);
