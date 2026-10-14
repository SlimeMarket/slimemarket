#!/usr/bin/env node
// Trigger all admin/cron jobs with the cron secret and report status + body.
import fs from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
function loadEnv(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[s.slice(0, i).trim()] = v;
  }
  return out;
}
const env = { ...loadEnv(".env.local"), ...process.env };
const secret = env.INDEXER_CRON_SECRET || env.CRON_SECRET;
const base = env.APP_BASE_URL || "http://127.0.0.1:3000";
if (!secret) {
  console.error("No INDEXER_CRON_SECRET in env");
  process.exit(1);
}

const jobs = [
  "admin/indexer/run",
  "admin/reconcile/onchain-releases",
  "admin/reconcile/onchain-ids",
  "admin/reconcile/balance",
  "admin/reconcile/failed-withdrawals",
  "admin/sweep/allowance",
  "admin/sweep/drafts",
  "admin/auto-release",
];

let ok = 0, bad = 0;
for (const j of jobs) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/${j}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, "x-cron-secret": secret },
    body: "{}",
  });
  const body = await r.text();
  const ms = Date.now() - t0;
  const mark = r.status >= 200 && r.status < 300 ? "OK " : "ERR";
  if (mark === "OK ") ok++; else bad++;
  console.log(`${mark} ${String(r.status).padEnd(4)} ${j.padEnd(38)} ${String(ms + "ms").padEnd(8)} ${body.slice(0, 220)}`);
}
console.log(`\n${ok} ok / ${bad} err`);
