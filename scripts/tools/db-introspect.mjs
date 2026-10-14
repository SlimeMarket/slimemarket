#!/usr/bin/env node
// DB introspection using the project's own service-role key.
// Usage: node scripts/tools/db-introspect.mjs
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
    let k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadEnv(".env.local"), ...process.env };
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  console.error("MISSING url=%s key=%s", !!url, !!key);
  process.exit(1);
}
console.log("URL :", url);
console.log("KEY :", key.slice(0, 12) + "… (" + key.length + " chars)");
console.log("");

const H = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function q(table, { select = "*", order, limit, filter = "" } = {}) {
  let u = `${url}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
  if (filter) u += "&" + filter;
  if (order) u += `&order=${order}`;
  if (limit) u += `&limit=${limit}`;
  const r = await fetch(u, { headers: { ...H, Prefer: "count=exact" } });
  const body = await r.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = body;
  }
  return { status: r.status, count: r.headers.get("content-range"), data };
}

const tables = [
  "orders",
  "wallet_txs",
  "notifications",
  "wallets",
  "products",
  "stores",
  "chats",
  "messages",
];

for (const t of tables) {
  const r = await q(t, { select: "id", limit: 1 });
  if (r.status !== 200) {
    console.log(`${t.padEnd(16)} HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    continue;
  }
  console.log(`${t.padEnd(16)} rows=${r.count}`);
}

console.log("\n--- newest orders ---");
const o = await q("orders", {
  select: "id,status,product_id,buyer_id,seller_id,total_price,created_at,updated_at",
  order: "created_at.desc",
  limit: 5,
});
console.log(JSON.stringify(o.data, null, 2));

console.log("\n--- newest wallet_txs ---");
const w = await q("wallet_txs", {
  select: "*",
  order: "created_at.desc",
  limit: 6,
});
console.log(JSON.stringify(w.data, null, 2));

console.log("\n--- newest notifications ---");
const n = await q("notifications", {
  select: "*",
  order: "created_at.desc",
  limit: 6,
});
console.log(JSON.stringify(n.data, null, 2));
