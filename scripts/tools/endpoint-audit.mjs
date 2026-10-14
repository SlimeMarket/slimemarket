#!/usr/bin/env node
/**
 * endpoint-audit.mjs — sweep EVERY API route and classify it.
 *
 * For each discovered `app/api/**\/route.ts`, issue the methods it exports and
 * classify the response:
 *   JSON-OK        — 2xx and a JSON body (route exists and answered)
 *   JSON-<status>  — JSON error (route exists; auth/validation refused)
 *   SPA-FALLBACK   — HTML body (route DOES NOT EXIST; the SPA shell answered)
 *   FETCH-ERR      — network/parse failure
 *
 * Runs authenticated with a real UCW session so auth-gated routes are reached.
 *
 * Usage: node scripts/tools/endpoint-audit.mjs [--session .secrets/ucw-X.json]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = (arg("--base", process.env.AUDIT_BASE || "http://localhost:3000")).replace(/\/$/, "");

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

// --- discover routes + the methods each exports ------------------------------
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name === "route.ts") acc.push(p);
  }
  return acc;
}
const files = walk(path.join(ROOT, "app", "api"));
const routes = files.map((f) => {
  const src = fs.readFileSync(f, "utf8");
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) =>
    new RegExp(`export\\s+async\\s+function\\s+${m}\\b|export\\s*\\{[^}]*\\b${m}\\b`).test(src),
  );
  let url = f.slice(path.join(ROOT, "app").length).replace(/[\\/]route\.ts$/, "").replace(/\\/g, "/");
  return { file: f, url, methods: methods.length ? methods : ["GET"] };
});

// --- auth --------------------------------------------------------------------
const sessPath = arg("--session", ".secrets/ucw-testseller.json");
let cookie = "";
try {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, sessPath), "utf8"));
  cookie = (s.cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
} catch { /* anonymous */ }

// Substitute obvious dynamic segments with a known id when we can, else a probe.
const SAMPLE = {
  "[id]": "00000000-0000-0000-0000-000000000000",
  "[uid]": "testseller",
  "[channel]": "global",
};

async function probe(url, method, attempt = 0) {
  let u = url;
  for (const [seg, val] of Object.entries(SAMPLE)) u = u.replace(seg, val);
  try {
    const ac = new AbortController();
    // 30s, not 15s. On a cold `next dev` a route can take 25s+ to compile
    // (the catch-all SPA route alone is ~25s), and after ~180 sequential
    // probes the server is also GC-thrashing. A 15s budget produced
    // intermittent FETCH-ERR on routes that are in fact healthy — e.g.
    // /api/chats/[id] answers 200 in 0.3s warm but took 6.2s on first hit.
    const t = setTimeout(() => ac.abort(), 30_000);
    const r = await fetch(BASE + u, {
      method,
      headers: {
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== "GET" ? { "Content-Type": "application/json", Origin: BASE, Referer: BASE + "/" } : {}),
      },
      ...(method !== "GET" ? { body: "{}" } : {}),
      signal: ac.signal,
    });
    clearTimeout(t);
    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    const isHtml = ct.includes("text/html") || body.trimStart().startsWith("<!DOCTYPE");
    if (isHtml) return { verdict: "SPA-FALLBACK", status: r.status, note: "" };
    const isJson = ct.includes("application/json");
    if (isJson && r.ok) return { verdict: "JSON-OK", status: r.status, note: body.slice(0, 60).replace(/\s+/g, " ") };
    if (isJson) return { verdict: `JSON-${r.status}`, status: r.status, note: body.slice(0, 60).replace(/\s+/g, " ") };
    return { verdict: `OTHER-${r.status}`, status: r.status, note: ct.split(";")[0] };
  } catch (e) {
    // A dev server compiling a route on first hit can be slow; retry twice with
    // growing backoff before declaring the endpoint broken (otherwise the whole
    // run is noise). A timeout that clears on retry is a cold-compile artefact,
    // not a broken route.
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return probe(url, method, attempt + 1);
    }
    return { verdict: "FETCH-ERR", status: "-", note: String(e).slice(0, 60) };
  }
}

const results = [];
const TOTAL = routes.reduce((n, r) => n + r.methods.length, 0);
let done = 0;
let consecutiveErrors = 0;
const t0 = Date.now();

// Probe the "cheap" routes first (1xx/2xx/3xx-looking, no path params) and the
// expensive / synthesised ones last. A `next dev` OOM-restart mid-sweep killed a
// previous run at probe 70/183 and made 25 perfectly healthy routes look
// missing; with this order a wedge costs us the least-informative probes.
const rank = (rt) => {
  let s = 0;
  if (rt.url.includes("[")) s += 100;          // needs a synthetic id
  if (rt.methods.some((m) => m !== "GET")) s += 10; // writes: more compile work
  return s;
};
routes.sort((a, b) => rank(a) - rank(b));

for (const rt of routes) {
  for (const m of rt.methods) {
    const r = await probe(rt.url, m);
    results.push({ ...rt, method: m, ...r });
    done++;
    // Stream progress: the previous version buffered to a log file, so a wedged
    // run was indistinguishable from a slow one for ten minutes.
    if (r.verdict === "FETCH-ERR") consecutiveErrors++;
    else consecutiveErrors = 0;
    if (done % 10 === 0 || consecutiveErrors > 0) {
      console.log(`   [${String(done).padStart(3)}/${TOTAL}] ${m.padEnd(6)} ${rt.url} → ${r.verdict}`);
    }
    // The dev server has genuinely wedged → stop early instead of waiting.
    if (consecutiveErrors >= 25) {
      console.log(`\n!!! 25 consecutive FETCH-ERR — server appears wedged; aborting at ${done}/${TOTAL}`);
      break;
    }
    // Pace the sweep: hammering an unbounded loop of fetches wedges `next dev`
    // (connection pile-up → the server stops answering, not the app failing).
    await new Promise((res) => setTimeout(res, 60));
  }
  if (consecutiveErrors >= 25) break;
}
console.log(`\n   sweep finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// --- report ------------------------------------------------------------------
const counts = {};
for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

console.log(`\nENDPOINT AUDIT  →  ${BASE}  (${sessPath})`);
console.log("=".repeat(84));
console.log(
  `${routes.length} route files · ${results.length} method probes · ` +
  `${counts["JSON-OK"] || 0} JSON-OK · ${counts["SPA-FALLBACK"] || 0} missing\n`,
);

const broken = results.filter((r) => r.verdict === "SPA-FALLBACK" || r.verdict === "FETCH-ERR");
if (broken.length) {
  console.log("❌ MISSING / BROKEN ROUTES");
  for (const r of broken) console.log(`   ${r.method.padEnd(7)} ${r.url}   [${r.verdict}]`);
  console.log("");
}

const errs = results.filter((r) => /^JSON-5/.test(r.verdict));
if (errs.length) {
  console.log("⚠️  5xx (route exists but threw)");
  for (const r of errs) console.log(`   ${r.method.padEnd(7)} ${r.url}   ${r.note}`);
  console.log("");
}

const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]);
console.log("VERDICT SUMMARY");
for (const [k, v] of summary) console.log(`   ${String(v).padStart(4)}  ${k}`);

fs.writeFileSync(path.join(ROOT, ".secrets", "endpoint-audit.json"), JSON.stringify(results, null, 2));
console.log("\nfull detail → .secrets/endpoint-audit.json\n");
