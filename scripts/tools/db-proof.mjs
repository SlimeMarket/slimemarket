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

const r = await fetch(`${url}/rest/v1/orders?id=eq.bd110510-92cf-42bd-8595-1e09b7bc561c&select=*`, { headers: H });
const [o] = await r.json();
console.log("=== DONE ORDER (proven on-chain) ===");
console.log(JSON.stringify(o, null, 2));

console.log("\n=== wallet_txs for payer ===");
if (o?.payer_address) {
  const w = await fetch(`${url}/rest/v1/wallet_txs?select=*&order=created_at.desc&limit=20`, { headers: H });
  const rows = await w.json();
  for (const t of rows) {
    console.log([t.type, String(t.amount).padStart(9), (t.status || "").padEnd(8), (t.label || "").slice(0, 28).padEnd(30), (t.arc_tx_hash || "").slice(0, 20)].join("  "));
  }
}

console.log("\n=== notifications ===");
const n = await fetch(`${url}/rest/v1/notifications?select=*&order=created_at.desc&limit=10`, { headers: H });
console.log(JSON.stringify(await n.json(), null, 2));

console.log("\n=== wallets ===");
const wz = await fetch(`${url}/rest/v1/wallets?select=*&limit=15`, { headers: H });
const wl = await wz.json();
for (const w of wl) {
  console.log([w.id?.slice(0, 8), (w.address || "").slice(0, 20), (w.circle_wallet_id || "").slice(0, 12), (w.usdc_balance ?? "?"), w.wallet_type || "", w.chain || w.blockchain || ""].join("  "));
}
