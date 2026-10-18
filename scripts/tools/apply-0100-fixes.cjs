// One-off: backfill the data side of migration 0100 without needing DDL on
// Supabase. The function REPLACE in 0100_reconcile_instant_sold_and_soldout.sql
// still needs to be applied in the Supabase SQL Editor (it's a CREATE OR
// REPLACE FUNCTION). This script handles the UPDATE backfill so the home and
// explore pages stop showing sold-out products right now.
//
// What it does (mirrors the backfill block in 0100_…sql):
//   1. products.sold    ← count(product_stock_items WHERE status='sold')
//   2. products.stock   ← same count, for instant products
//   3. products.status  ← 'soldout' when 0 available, 'active' when restocked
//
// Safe to re-run.

const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const env = {};
for (const line of fs.readFileSync(".env.production", "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

(async () => {
  // 1. sold / stock from product_stock_items (instant products only).
  const counts = await sb
    .from("product_stock_items")
    .select("product_id, status");
  if (counts.error) { console.error("stock items read failed:", counts.error.message); return; }
  const map = new Map();
  for (const r of counts.data || []) {
    const m = map.get(r.product_id) || { sold: 0, available: 0 };
    if (r.status === "sold") m.sold += 1;
    if (r.status === "available") m.available += 1;
    map.set(r.product_id, m);
  }
  const products = await sb.from("products").select("id, name, status, stock, sold, delivery").eq("delivery", "instant");
  if (products.error) { console.error("products read failed:", products.error.message); return; }
  let updatedCounts = 0, flippedSoldout = 0, reactivated = 0, skipped = 0;
  for (const p of products.data || []) {
    const m = map.get(p.id);
    if (!m) { skipped += 1; continue; }
    const newSold = m.sold;
    const newStock = m.sold; // for instant, stock mirrors sold
    const updates = {};
    if (p.sold !== newSold || p.stock !== newStock) {
      updates.sold = newSold;
      updates.stock = newStock;
      updatedCounts += 1;
    }
    if (m.available === 0 && p.status !== "soldout") {
      updates.status = "soldout";
      flippedSoldout += 1;
    } else if (m.available > 0 && p.status === "soldout") {
      updates.status = "active";
      reactivated += 1;
    }
    if (Object.keys(updates).length) {
      const { error } = await sb.from("products").update(updates).eq("id", p.id);
      if (error) { console.error("update failed for", p.name, error.message); }
    }
  }
  console.log(JSON.stringify({
    backfilled: updatedCounts, flippedSoldout, reactivated, productsWithoutStockTable: skipped,
  }, null, 2));
})();
