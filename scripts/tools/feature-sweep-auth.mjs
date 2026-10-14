#!/usr/bin/env node
// Authenticated feature sweep using the saved UCW browser session cookies.
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

const which = process.argv[2] || ".secrets/ucw-testsellerxnzwo.json";
const sess = JSON.parse(fs.readFileSync(which, "utf8"));
const cookieHeader = (sess.cookies || [])
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");

console.log("session:", sess.email, "| cookies:", sess.cookieCount, "| status:", sess.finalStatus);
console.log("");

const GETS = [
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
  "/api/wallet",
  "/api/wallet/history",
  "/api/wallet/bank-accounts",
  "/api/wallet/external",
  "/api/wallet/gateway/balance",
  "/api/notifications",
  "/api/chats",
  "/api/orders",
  "/api/sales/recent",
  "/api/sales/stats",
  "/api/currencies",
  "/api/forum/channels",
  "/api/referral",
  "/api/wl/listings",
  "/api/wl/deals",
  "/api/products",
];

const H = { Cookie: cookieHeader, Accept: "application/json" };

function summarize(body) {
  try {
    const j = JSON.parse(body);
    if (Array.isArray(j)) return `array(${j.length})`;
    if (j && typeof j === "object") {
      const keys = Object.keys(j);
      // try to guess a count
      const cnt = j.count ?? j.total ?? (Array.isArray(j.items) ? j.items.length : undefined)
        ?? (Array.isArray(j.orders) ? j.orders.length : undefined)
        ?? (Array.isArray(j.products) ? j.products.length : undefined)
        ?? (Array.isArray(j.txs) ? j.txs.length : undefined);
      return `obj{${keys.slice(0, 5).join(",")}${keys.length > 5 ? ",…" : ""}}` + (cnt !== undefined ? ` n=${cnt}` : "");
    }
    return JSON.stringify(j).slice(0, 60);
  } catch {
    return body.slice(0, 60).replace(/\s+/g, " ");
  }
}

let ok = 0, err = 0;
for (const p of GETS) {
  try {
    const r = await fetch(base + p, { headers: H });
    const body = await r.text();
    const good = r.status === 200;
    if (good) ok++; else err++;
    console.log(`${good ? "OK " : "ERR"} ${String(r.status).padEnd(4)} ${p.padEnd(32)} ${summarize(body)}`);
  } catch (e) {
    err++;
    console.log(`ERR ---  ${p.padEnd(32)} ${String(e).slice(0, 70)}`);
  }
}
console.log(`\n${ok} ok / ${err} err`);
