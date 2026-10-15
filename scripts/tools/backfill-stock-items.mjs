#!/usr/bin/env node
/**
 * backfill-stock-items.mjs — mirror legacy `products.stock_items` into
 * `product_stock_items` for single-variant (Default) instant products.
 *
 * WHY: products created before the createProduct fix kept their stock ONLY in
 * the legacy text[] array. `product_stock_items` (what the seller center /
 * storefront count) was empty, so the two stores disagreed after a restock.
 * This inserts the missing rows so every view shows the same number.
 *
 * Safe + idempotent: only inserts secrets that are not already present for the
 * product. Run with --dry to preview.
 *
 * Usage:
 *   node --env-file=.env.production scripts/tools/backfill-stock-items.mjs [--dry]
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
const DRY = process.argv.includes("--dry");

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function get(p) {
  const r = await fetch(`${URL}/rest/v1/${p}`, { headers: H });
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

const products = await get(
  "products?delivery=eq.instant&select=id,name,stock_items,variants,price",
);
const allItems = await get("product_stock_items?select=product_id,secret,variant_label");
const have = new Map();
for (const it of allItems) {
  const k = `${it.product_id}\u0000${it.secret}`;
  have.set(k, true);
}

let inserted = 0, touched = 0;
for (const p of products) {
  const legacy = Array.isArray(p.stock_items) ? p.stock_items.filter(s => typeof s === "string" && s.trim()) : [];
  if (legacy.length === 0) continue;
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const realVariants = variants.filter(v => !(variants.length === 1 && v.label === "Default"));
  if (realVariants.length > 0) continue; // multi-variant: ambiguous label, skip

  const missing = legacy.filter(s => !have.has(`${p.id}\u0000${s.trim()}`));
  if (missing.length === 0) continue;
  touched++;
  console.log(`\n${p.name} (${p.id})`);
  console.log(`  legacy=${legacy.length}  missing in product_stock_items=${missing.length}`);
  for (const s of missing) console.log(`    + ${JSON.stringify(s)}`);
  if (DRY) continue;

  const rows = missing.map(secret => ({
    product_id: p.id, variant_label: "Default", secret: secret.trim(), status: "available",
  }));
  const r = await fetch(`${URL}/rest/v1/product_stock_items`, {
    method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(rows),
  });
  if (!r.ok) { console.error(`  !! insert failed: HTTP ${r.status} ${await r.text()}`); continue; }
  inserted += rows.length;
}

console.log(`\n${DRY ? "[DRY] would touch" : "Touched"} ${touched} product(s); ${DRY ? "" : "inserted " + inserted + " row(s)"}`);

// --- Pass 2: sync stale `variants[].price` back to `products.price` ---------
// Public views render the price from variants[], so a seller edit that only
// updated products.price left every public view on the OLD price.
const all = await get("products?select=id,name,price,variants");
let synced = 0;
for (const p of all) {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  if (variants.length !== 1) continue; // only the single-variant (Default) case is unambiguous
  const want = Number(p.price);
  const cur = Number(variants[0]?.price);
  if (!Number.isFinite(want) || want === cur) continue;
  synced++;
  console.log(`  ~ ${p.name}: variants[0].price ${cur / 1e6} -> ${want / 1e6}`);
  if (DRY) continue;
  const r = await fetch(`${URL}/rest/v1/products?id=eq.${p.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ variants: [{ ...variants[0], price: want }] }),
  });
  if (!r.ok) console.error(`    !! price sync failed: HTTP ${r.status} ${await r.text()}`);
}
console.log(`  ${DRY ? "[DRY] would sync" : "Synced"} ${synced} variant price(s)\n`);

