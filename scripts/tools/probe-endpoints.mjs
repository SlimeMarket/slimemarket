// Probe every API route and classify the response.
//
// A catch-all frontend route answers unknown /api/* paths with HTML 200, which
// looks like success. Classify by content-type, not status.
//
//   node scripts/tools/probe-endpoints.mjs [baseUrl] [--auth <cookieFile>]
//
// Without a session the sweep proves routes EXIST (401/403) — it does not prove
// they work. What it does prove: no SPA fallbacks, and no 500s.

import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] || "http://localhost:3000";
const skip = /node_modules|\.next|\.git/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skip.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push(p.split(path.sep).join("/"));
  }
  return out;
}

const routes = walk("app/api").map((f) =>
  f.replace(/^app/, "").replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, "00000000-0000-0000-0000-000000000000")
);

const results = { fallback: [], json200: [], json4xx: [], json5xx: [], other: [] };

async function probe(p) {
  const url = BASE + p;
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    });
    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    if (ct.includes("text/html") || body.trimStart().startsWith("<!DOCTYPE")) {
      results.fallback.push(`${p}  [${r.status}]`);
    } else if (ct.includes("application/json")) {
      if (r.status === 200) results.json200.push(p);
      else if (r.status >= 500) results.json5xx.push(`${p}  [${r.status}] ${body.slice(0, 160)}`);
      else results.json4xx.push(`${p}  [${r.status}]`);
    } else {
      results.other.push(`${p}  [${r.status}] ${ct} ${body.slice(0, 80)}`);
    }
  } catch (e) {
    results.other.push(`${p}  THROW ${e.message}`);
  }
}

const CONCURRENCY = 6;
let i = 0;
async function worker() {
  while (i < routes.length) {
    const p = routes[i++];
    await probe(p);
    process.stdout.write(`\r${i}/${routes.length} probed`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write("\n\n");

console.log(`routes probed      : ${routes.length}`);
console.log(`SPA-FALLBACK (HTML): ${results.fallback.length}   <- must be 0`);
console.log(`JSON 200           : ${results.json200.length}`);
console.log(`JSON 4xx           : ${results.json4xx.length}   (auth refusals = routes exist)`);
console.log(`JSON 5xx           : ${results.json5xx.length}   <- server-side bugs`);
console.log(`other              : ${results.other.length}`);

for (const [label, arr] of [["SPA-FALLBACK", results.fallback], ["JSON 5xx", results.json5xx], ["OTHER", results.other]]) {
  if (!arr.length) continue;
  console.log(`\n--- ${label} ---`);
  arr.forEach((x) => console.log("  " + x));
}
