#!/usr/bin/env node
/**
 * Read-only state snapshot: orders, PENDING leftovers, lifecycle events,
 * wallet_txs, wallet balances. Used after the bug-fix wave to prove nothing
 * regressed. Usage: node scripts/tools/state-check.mjs
 */
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
const supaUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const supaKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
if (!supaUrl || !supaKey) {
  console.error("Missing Supabase env");
  process.exit(1);
}
const S = { apikey: supaKey, Authorization: `Bearer ${supaKey}` };
async function db(q) {
  const r = await fetch(`${supaUrl}/rest/v1/${q}`, { headers: S });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t.slice(0, 400); }
}

console.log("=== LAST 8 ORDERS ===");
const orders = await db("orders?select=id,status,payment,amount,buyer_fee,circle_fee,gas_fee,on_chain_order_id,on_chain_status,created_at&order=created_at.desc&limit=8");
if (Array.isArray(orders)) {
  for (const o of orders) {
    console.log(
      [
        (o.status || "?").padEnd(11),
        (o.payment || "?").padEnd(9),
        "amt=" + o.amount,
        "bf=" + o.buyer_fee,
        "cf=" + o.circle_fee,
        "gf=" + o.gas_fee,
        "oc=" + (o.on_chain_order_id ?? "-"),
        "ocs=" + (o.on_chain_status ?? "-"),
        (o.created_at || "").slice(0, 19),
      ].join("  ")
    );
  }
} else console.log(orders);

async function count(table, filter = "") {
  const rows = await db(`${table}?select=id${filter}&limit=2000`);
  return Array.isArray(rows) ? rows.length : rows;
}
console.log("\n=== COUNTS ===");
console.log("orders total        :", await count("orders"));
console.log("PENDING             :", await count("orders", "&status=eq.PENDING"));
console.log("SENT                :", await count("orders", "&status=eq.SENT"));
console.log("DONE+COMPLETED      :", await count("orders", "&status=in.(DONE,COMPLETED)"));
console.log("wallet_txs          :", await count("wallet_txs"));
console.log("lifecycle_events    :", await count("lifecycle_events"));
console.log("notifications       :", await count("notifications"));
console.log("wallets             :", await count("wallets"));
console.log("products            :", await count("products"));
console.log("stores              :", await count("stores"));

console.log("\n=== TREASURY / WALLET BALANCES ===");
const wallets = await db("wallets?select=user_id,address,usdc_balance,forum_balance,wallet_type&limit=50");
if (Array.isArray(wallets)) {
  for (const w of wallets) console.log(`  ${(w.address || "?").slice(0, 14)}...  usdc=${w.usdc_balance}  forum=${w.forum_balance}  type=${w.wallet_type || "-"}`);
} else console.log(wallets);

console.log("\n=== LIFECYCLE for last 3 on-chain orders ===");
const onchain = Array.isArray(orders) ? orders.filter((o) => o.on_chain_order_id) : [];
for (const o of onchain.slice(0, 3)) {
  const ev = await db(`lifecycle_events?select=operation,tx_hash,amount,created_at&order_id=eq.${o.id}&order=created_at.asc`);
  console.log(`order ${o.id} status=${o.status} ocOrder=${o.on_chain_order_id} ocStatus=${o.on_chain_status}`);
  if (Array.isArray(ev)) for (const e of ev) console.log("   ", String(e.operation || "(null)").padEnd(12), "amt=" + e.amount, (e.created_at || "").slice(0, 19));
  else console.log("   ", ev);
}
