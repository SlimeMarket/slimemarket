#!/usr/bin/env node
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
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
const H = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" };

const cands = [
  "profiles", "users", "stores", "store_members", "products", "product_variants", "stock_items",
  "orders", "wallets", "wallet_txs", "notifications", "disputes", "withdrawals",
  "wl_deals", "wl_listings", "mm_applications", "mm_audit", "recovery_wallets",
  "lifecycle_events", "reports", "conversations", "chat_messages", "chats", "messages",
  "dm_threads", "dm_messages", "feedback", "audit_log", "kyc", "sessions",
  "escrow_orders", "reconcile_queue", "otp_codes", "reset_codes",
];

const found = [], missing = [];
for (const t of cands) {
  const r = await fetch(`${url}/rest/v1/${t}?select=id&limit=1`, { headers: H });
  if (r.status === 200) found.push(`${t.padEnd(22)} ${r.headers.get("content-range")}`);
  else missing.push(`${t.padEnd(22)} ${r.status}`);
}
console.log("=== EXISTING TABLES ===");
console.log(found.join("\n") || "(none)");
console.log("\n=== NOT FOUND ===");
console.log(missing.join("\n"));

// Dump full table list from pg via RPC-less trick: openapi spec
console.log("\n=== OPENAPI PATHS ===");
const r2 = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" } });
if (r2.status === 200) {
  const spec = await r2.json();
  const defs = Object.keys(spec.definitions || {});
  console.log(defs.sort().join("\n"));
} else {
  console.log("openapi HTTP", r2.status);
}
