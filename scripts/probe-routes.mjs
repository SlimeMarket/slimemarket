/**
 * Probe every API route and classify the response.
 *
 * A green test suite says nothing about whether the routes actually respond. This
 * drives the LIVE server and classifies by content-type, because a catch-all
 * frontend route answers unknown /api/* paths with HTML 200 — which looks like
 * success if you only check the status code.
 *
 * The classification that matters most is `500-empty`: a handler that throws
 * before its own try/catch returns the framework's generic error page with an
 * empty body, so the client gets a 500 instead of the intended 401/403/404.
 *
 * Usage:
 *   node scripts/probe-routes.mjs [baseUrl]
 *   node scripts/probe-routes.mjs [baseUrl] --cookie-file=.secrets/_cookies.txt
 *   node scripts/probe-routes.mjs [baseUrl] --delay=150
 *
 * A wall of 401s proves the routes exist, not that they work — so replay the
 * sweep with a real session (`--cookie-file`) to reach the handlers. The delay
 * matters too: the API rate-limits at 5 req/min per bucket, and a 429 is a
 * non-answer, not a pass.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const cookieArg = args.find((a) => a.startsWith("--cookie-file="));
const delayArg = args.find((a) => a.startsWith("--delay="));
const DELAY_MS = delayArg ? Number(delayArg.split("=")[1]) : 0;

/**
 * Netscape cookie jar → `k=v; k2=v2`.
 *
 * Two format details that silently produce an empty header if missed:
 *  - httpOnly cookies are written with a `#HttpOnly_` prefix, so a naive
 *    "skip lines starting with #" filter drops exactly the session cookie.
 *  - the file is CRLF; the trailing \r ends up inside the value and the server
 *    rejects the cookie.
 */
function loadCookieHeader(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const pairs = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    // Strip the httpOnly marker but keep the cookie; skip real comments.
    const effective = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
    if (effective.startsWith("#")) continue;
    const parts = effective.split("\t");
    if (parts.length >= 7) pairs.push(`${parts[5]}=${parts[6]}`);
  }
  return pairs.join("; ");
}

const cookieHeader = cookieArg ? loadCookieHeader(cookieArg.split("=")[1]) : "";
if (cookieArg) {
  if (cookieHeader) console.log(`Session: ${cookieHeader.split("; ").length} cookies loaded\n`);
  else console.log("⚠️  cookie file empty — sweep will run without a session\n");
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name === "route.ts") acc.push(p);
  }
  return acc;
}

/** app/api/wl/deals/[id]/release/route.ts → /api/wl/deals/<id>/release */
const toPath = (file) =>
  "/" + file.replace(/\\/g, "/").replace(/^app\//, "").replace(/\/route\.ts$/, "")
    .replace(/\[([^\]]+)\]/g, "<$1>");

const routes = walk("app/api").map(toPath).sort();

const results = { ok: [], json4xx: [], spa: [], html: [], empty500: [], other: [] };

for (const route of routes) {
  // Fill dynamic segments with a value that parses but will not exist.
  const url = BASE + route.replace(/<[^>]+>/g, "00000000-0000-0000-0000-000000000000");
  if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    results.other.push({ route, detail: `fetch failed: ${e.message}` });
    continue;
  }

  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const trimmed = body.trimStart();
  const isHtml = ct.includes("text/html") || trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html");

  if (isHtml) {
    // The SPA fallback answers unknown paths — the route does not really exist.
    if (res.status === 200) results.spa.push({ route, status: res.status });
    else results.html.push({ route, status: res.status });
    continue;
  }

  if (res.status === 500 && body.trim() === "") {
    results.empty500.push({ route });
    continue;
  }
  if (res.status === 500) {
    results.other.push({ route, detail: `500 with body: ${body.slice(0, 120)}` });
    continue;
  }
  if (res.status >= 200 && res.status < 300) results.ok.push({ route, status: res.status });
  else results.json4xx.push({ route, status: res.status, detail: body.slice(0, 90) });
}

const line = (s) => console.log(s);
line(`Total routes probed : ${routes.length}`);
line("");
line(`✅ JSON 2xx            : ${results.ok.length}`);
line(`🔒 JSON 4xx (auth/404) : ${results.json4xx.length}`);
line(`👻 SPA fallback (HTML) : ${results.spa.length}   ← route missing`);
line(`⚠️  HTML non-200        : ${results.html.length}`);
line(`💥 500 body EMPTY      : ${results.empty500.length}   ← throw before try/catch`);
line(`❓ other              : ${results.other.length}`);

if (results.ok.length) {
  line("\n--- JSON 2xx (handlers actually run) ---");
  for (const r of results.ok) line(`  ${r.route}  [${r.status}]`);
}
if (results.empty500.length) {
  line("\n--- 500 WITHOUT BODY (must be fixed) ---");
  for (const r of results.empty500) line(`  ${r.route}`);
}
if (results.spa.length) {
  line("\n--- SPA FALLBACK (route missing) ---");
  for (const r of results.spa) line(`  ${r.route}`);
}
if (results.other.length) {
  line("\n--- OTHER ---");
  for (const r of results.other) line(`  ${r.route}  ${r.detail}`);
}
if (results.json4xx.length && cookieHeader) {
  line("\n--- 4xx even WITH a session (check manually) ---");
  for (const r of results.json4xx.filter((x) => x.status !== 429 && x.status !== 405).slice(0, 25)) {
    line(`  ${r.route}  [${r.status}]  ${r.detail}`);
  }
}

// A summary of 4xx codes is useful: a wall of 401s proves routes exist but says
// nothing about whether they work — the next step is to replay with a session.
const byCode = {};
for (const r of results.json4xx) byCode[r.status] = (byCode[r.status] ?? 0) + 1;
line("\n4xx distribution: " + Object.entries(byCode).map(([k, v]) => `${k}×${v}`).join("  "));

process.exitCode = results.empty500.length || results.spa.length ? 1 : 0;
