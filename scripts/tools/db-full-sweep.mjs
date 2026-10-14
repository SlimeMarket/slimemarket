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
const H = { apikey: key, Authorization: `Bearer ${key}` };

const tables = (process.argv[2] || "").split(",").filter(Boolean);
const T = tables.length
  ? tables
  : [
      "users", "stores", "products", "product_stock_items", "orders", "wallets", "wallet_txs",
      "notifications", "disputes", "wl_deals", "wl_listings", "recovery_wallets", "lifecycle_events",
      "reports", "chat_messages", "chat_threads", "audit_log", "mm_audit_log", "mm_audit_log_failed",
      "rekber_tx", "seller_applications", "reviews", "bank_accounts", "external_wallets",
      "reconciliation_queue", "indexer_state", "ledger_entries", "secret_vault", "tx_groups",
      "referrals", "referral_events", "blocklist_addresses", "currency_rates", "user_currency_preferences",
      "webhook_events", "auth_nonces", "temp_reset_codes",
    ];

for (const t of T) {
  const r = await fetch(`${url}/rest/v1/${t}?select=*&limit=0`, {
    headers: { ...H, Prefer: "count=exact", Range: "0-0" },
  });
  const cr = r.headers.get("content-range") || "?";
  console.log(`\n### ${t}  [${r.status}] rows=${cr}`);
  // fetch 2 sample rows to show shape
  const r2 = await fetch(`${url}/rest/v1/${t}?select=*&limit=2`, { headers: H });
  if (r2.status === 200) {
    const rows = await r2.json();
    if (Array.isArray(rows) && rows.length) {
      console.log("cols:", Object.keys(rows[0]).join(", "));
    } else console.log("(empty)");
  }
}
