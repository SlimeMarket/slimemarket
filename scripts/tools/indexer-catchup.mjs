#!/usr/bin/env node
/**
 * indexer-catchup.mjs — drive the indexer forward until it reaches chain head.
 *
 * The indexer advances a fixed window per run (~2000 blocks by default), so from
 * a cold start it needs many sequential calls before `indexer lag` in
 * /api/health stops reporting `degraded`. This loops until the cursor is within
 * a small window of head, or `--max` runs have elapsed.
 *
 * Auth: `?cron_secret=` (the `x-cron-secret` header is ignored → 401).
 *
 * Usage: node scripts/tools/indexer-catchup.mjs [--max 60]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const MAX = Number(arg("--max", 60));
const BASE = (arg("--base", "http://localhost:3000")).replace(/\/$/, "");

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s.startsWith("#")) continue;
  const i = s.indexOf("=");
  if (i < 0) continue;
  let v = s.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[s.slice(0, i).trim()] = v;
}
const SECRET = env.INDEXER_CRON_SECRET;
if (!SECRET) { console.error("INDEXER_CRON_SECRET missing from .env.local"); process.exit(1); }

const health = async () => {
  const r = await fetch(`${BASE}/api/health`);
  return (await r.json()).checks.indexer;
};
const lagOf = (detail) => {
  const m = /lag (\d+) blocks/.exec(detail || "");
  if (m) return Number(m[1]);
  return 0;
};

let start = await health();
console.log(`start: ${start.detail}`);

let i = 0;
for (; i < MAX; i++) {
  const r = await fetch(`${BASE}/api/admin/indexer/run?cron_secret=${encodeURIComponent(SECRET)}`);
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200) { console.log(`  run ${i}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`); break; }
  if (i % 5 === 0 || i === MAX - 1) {
    console.log(`  run ${i}: ${j.fromBlock} → ${j.toBlock} (processed ${j.processed})`);
  }
  if (j.toBlock === "0xffffffff" || j.toBlock === null) { console.log("  reached chain head"); break; }
}

const end = await health();
console.log(`\nend: ${end.detail}`);
console.log(end.ok ? "✅ indexer caught up" : `⏳ still ${lagOf(end.detail)} blocks behind after ${i} run(s)`);
