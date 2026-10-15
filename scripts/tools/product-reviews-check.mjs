#!/usr/bin/env node
/**
 * product-reviews-check.mjs — verify the data path behind
 * GET /api/products/:id/reviews before/after a deploy.
 *
 * Mirrors lib/catalog/stores.ts getProductReviews():
 *   orders(product_id) → order ids → reviews(order_id in ...) → buyer avatars.
 *
 * Usage:
 *   node scripts/tools/product-reviews-check.mjs [productIdOrSlug]
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
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const get = async (p) => {
  const r = await fetch(`${URL}/rest/v1/${p}`, { headers: H });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
};

const arg = process.argv[2] || "f3bf08a1-0b3d-4407-a646-0f3ade4941e6";

// Resolve slug-or-uuid → product row.
const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
const prod = await get(`products?${isUuid ? `id=eq.${arg}` : `slug=eq.${arg}`}&select=id,name`);
const product = (prod.json || [])[0];
if (!product) { console.error("product not found:", arg, prod.status); process.exit(1); }
console.log("product:", product.id, "-", product.name);

const orders = await get(`orders?product_id=eq.${product.id}&select=id,buyer_id,status&order=created_at.desc&limit=500`);
const rows = orders.json || [];
console.log(`orders for product: ${rows.length}`);
const byStatus = {};
for (const o of rows) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
console.log("  by status:", byStatus);

if (rows.length === 0) { console.log("=> no orders yet (reviews impossible)"); process.exit(0); }

const ids = rows.map((o) => o.id).join(",");
const rev = await get(`reviews?order_id=in.(${ids})&select=order_id,display_name,rating,text,created_at&order=created_at.desc`);
const reviews = rev.json || [];
console.log(`reviews: ${reviews.length}`);
for (const r of reviews) console.log(`  - ${r.rating}★ ${r.display_name}: ${(r.text || "").slice(0, 60)}`);

if (reviews.length) {
  const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  console.log(`=> summary: avg ${avg.toFixed(1)} from ${reviews.length} review(s)`);
} else {
  console.log("=> product has orders but no reviews yet");
}
