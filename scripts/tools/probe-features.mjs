#!/usr/bin/env node
// Probe every feature API and classify: real JSON API vs SPA fallback (HTML).
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
const base = env.APP_BASE_URL || "http://127.0.0.1:3000";

const GETS = [
  "/api/health",
  "/api/products",
  "/api/sales/recent",
  "/api/sales/stats",
  "/api/currencies",
  "/api/forum/channels",
  "/api/notifications",
  "/api/chats",
  "/api/wallet",
  "/api/wallet/history",
  "/api/wallet/gateway/balance",
  "/api/wallet/gateway/constants",
  "/api/wallet/bank-accounts",
  "/api/wallet/external",
  "/api/wl/listings",
  "/api/wl/deals",
  "/api/mm/stats",
  "/api/me",
  "/api/my/orders",
  "/api/my/buys",
  "/api/my/earnings",
  "/api/my/transactions",
  "/api/my/products",
  "/api/my/store",
  "/api/my/sales-summary",
  "/api/my/pin-status",
  "/api/my/ucw-credentials",
  "/api/orders",
  "/api/referral",
  "/api/reports",
  "/api/admin/treasury",
];

const rows = [];
for (const p of GETS) {
  try {
    const r = await fetch(base + p, { headers: { Accept: "application/json" } });
    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    const isJson = ct.includes("application/json");
    const isHtml = ct.includes("text/html") || body.trimStart().startsWith("<!DOCTYPE");
    let verdict;
    if (isHtml) verdict = "SPA-FALLBACK";
    else if (isJson && r.status === 200) verdict = "JSON-OK";
    else if (isJson) verdict = `JSON-${r.status}`;
    else verdict = `OTHER-${r.status}`;
    rows.push({ p, status: r.status, verdict, ct: ct.split(";")[0], body: body.slice(0, 90).replace(/\s+/g, " ") });
  } catch (e) {
    rows.push({ p, status: "-", verdict: "FETCH-ERR", ct: "", body: String(e).slice(0, 80) });
  }
}

const pad = (s, n) => String(s).padEnd(n);
for (const r of rows) {
  console.log(`${pad(r.status, 5)} ${pad(r.verdict, 14)} ${pad(r.p, 34)} ${r.body}`);
}
const spaff = rows.filter((r) => r.verdict === "SPA-FALLBACK");
console.log(`\n${rows.length} probed · ${rows.filter((r) => r.verdict === "JSON-OK").length} JSON-OK · ${spaff.length} SPA fallbacks`);
if (spaff.length) console.log("SPA fallbacks (route does not exist):\n  " + spaff.map((r) => r.p).join("\n  "));
