#!/usr/bin/env node
/**
 * product-debug.mjs — dump the raw DB state for one product so we can see
 * exactly why the seller view and the public view disagree on price / stock.
 *
 * Usage:
 *   node --env-file=.env.production scripts/tools/product-debug.mjs <productIdOrSlug>
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
function loadEnv(file) {
  const out = {};
  const p = path.join(REPO, file);
  if (!existsSync(p)) return out;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[0] === v.at(-1)) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = loadEnv(".env.production");
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("missing supabase env"); process.exit(2); }

const arg = process.argv[2];
if (!arg) { console.error("usage: node scripts/tools/product-debug.mjs <id-or-slug>"); process.exit(2); }
// The public URL is `<slug>-<uuid>`; the uuid is the last 36 chars.
const id = arg.length > 36 ? arg.slice(-36) : arg;

async function sb(pathname) {
  const r = await fetch(`${URL}/rest/v1/${pathname}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const prod = await sb(`products?id=eq.${id}&select=id,name,price,variants,stock,stock_items,status,sold,delivery`);
const p = prod.json?.[0];
if (!p) { console.error("product not found:", id, JSON.stringify(prod.json)); process.exit(1); }

const items = await sb(`product_stock_items?product_id=eq.${id}&select=variant_label,status`);

console.log("\n=== PRODUCT ROW ===");
console.log("  id       :", p.id);
console.log("  name     :", p.name);
console.log("  status   :", p.status, "| delivery:", p.delivery, "| sold:", p.sold);
console.log("  price    :", p.price, "(micro) =", Number(p.price) / 1e6, "USDC");
console.log("  stock    :", p.stock, "  <-- products.stock column");
console.log("  variants :", JSON.stringify(p.variants));
console.log("  stock_items length:", (p.stock_items || []).length);
console.log("    stock_items:", JSON.stringify(p.stock_items));

console.log("\n=== product_stock_items (per-variant source of truth) ===");
const rows = items.json || [];
const byLabel = {};
for (const r of rows) byLabel[r.variant_label] = (byLabel[r.variant_label] || 0) + 1;
console.log("  total rows:", rows.length);
console.log("  by variant:", JSON.stringify(byLabel));
console.log("  available  :", rows.filter(r => r.status === "available").length);

console.log("\n=== VERDICT ===");
const vp = Array.isArray(p.variants) && p.variants[0] ? Number(p.variants[0].price) : null;
if (vp != null && vp !== Number(p.price)) {
  console.log(`  !! PRICE MISMATCH: products.price=${Number(p.price) / 1e6} but variants[0].price=${vp / 1e6}`);
  console.log("     Public views read variants[] -> they show the OLD price.");
} else {
  console.log("  price: variants[] matches products.price");
}
console.log(`  stock: products.stock=${p.stock}  stock_items=${(p.stock_items || []).length}  product_stock_items(available)=${rows.filter(r => r.status === "available").length}`);
console.log("");
