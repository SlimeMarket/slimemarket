#!/usr/bin/env node
/**
 * product-pin-sweep.mjs — exercise the areas the order/chat/business sweeps
 * never touched:
 *   • PIN lifecycle read paths (status, setup, change, restore, reset)
 *   • seller application (apply → admin gate)
 *   • product CRUD (create → variants → status → restock → image → delete)
 *   • admin-only route gates (a Member must be refused, never 5xx)
 *
 * Read-mostly. Mutations use a throwaway product that is cleaned up at the end.
 * A Member session is used throughout, so every admin route is expected to
 * answer 401/403 — a 500 there is a real bug worth catching.
 *
 * Usage: node scripts/tools/product-pin-sweep.mjs --as .secrets/ucw-testsellerxnzwo.json
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = (arg("--base", process.env.WF_BASE || "http://localhost:3000")).replace(/\/$/, "");
const sessPath = arg("--as", ".secrets/ucw-testsellerxnzwo.json");

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
const env = loadEnv(".env.local");
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function db(q) {
  const r = await fetch(`${SUPA}/rest/v1/${q}`, { headers: DBH });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t.slice(0, 200); }
}
async function dbWrite(q, method, body) {
  const r = await fetch(`${SUPA}/rest/v1/${q}`, {
    method,
    headers: { ...DBH, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const sess = JSON.parse(fs.readFileSync(path.join(ROOT, sessPath), "utf8"));
const COOKIE = (sess.cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");

let pass = 0, fail = 0, skip = 0;
const ok = (c, label, detail = "") => {
  if (c) { pass++; console.log(`  \u2713 ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  \u2717 ${label}${detail ? " — " + detail : ""}`); }
};
const skipped = (label, why) => { skip++; console.log(`  \u25CB ${label} — skipped (${why})`); };
const section = (t) => console.log(`\n[${t}]`);

async function api(method, p, body, extra = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      Cookie: COOKIE, Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json", Origin: BASE, Referer: BASE + "/" } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); }
  return { status: r.status, json: j };
}

/** A 5xx is always a bug; 4xx is a legitimate refusal. */
const not5xx = (r) => r.status < 500;

console.log("=".repeat(74));
console.log("PRODUCT / PIN / ADMIN-GATE SWEEP");
console.log("=".repeat(74));

const me = await api("GET", "/api/auth/me");
if (me.status !== 200) {
  console.error(`session invalid (HTTP ${me.status}) — run a signup first`);
  process.exit(1);
}
const ME = me.json.user ?? me.json;
console.log(`  session: ${ME.email}  uid=${ME.uid}  role=${ME.role}`);

// ─────────────────────────────────────────────────────────────────────────────
section("1. PIN lifecycle — read paths must never 5xx");

{
  const r = await api("GET", "/api/my/pin-status");
  ok(not5xx(r) && r.status === 200, "GET /api/my/pin-status", `HTTP ${r.status} ${r.json?.pinStatus ?? ""}`);
  ok(
    typeof r.json?.pinStatus === "string",
    "pin-status returns a pinStatus string",
    JSON.stringify(r.json).slice(0, 90),
  );
}

{
  // Setup/change/restore all mint a Circle challenge. With no userToken in the
  // DB-less dev path these can legitimately 4xx — but never 5xx.
  const r = await api("POST", "/api/my/pin-setup", {});
  ok(not5xx(r), "POST /api/my/pin-setup does not 5xx", `HTTP ${r.status}`);
}
{
  const r = await api("POST", "/api/my/pin-change", {});
  ok(not5xx(r), "POST /api/my/pin-change does not 5xx", `HTTP ${r.status}`);
}
{
  const r = await api("POST", "/api/my/pin-restore", {});
  ok(not5xx(r), "POST /api/my/pin-restore does not 5xx", `HTTP ${r.status}`);
}
{
  const r = await api("POST", "/api/my/pin-reset-request", {});
  ok(not5xx(r), "POST /api/my/pin-reset-request does not 5xx", `HTTP ${r.status}`);
}
{
  // An unauthenticated caller must be refused, not error.
  const r = await fetch(`${BASE}/api/my/pin-status`);
  ok(not5xx({ status: r.status }) && r.status === 401, "GET /api/my/pin-status unauthenticated → 401", `HTTP ${r.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
section("2. Seller application");

let appWasExisting = false;
{
  const r = await api("POST", "/api/me/apply-seller", {});
  const already = r.status === 409 || /already/i.test(JSON.stringify(r.json));
  appWasExisting = already;
  ok(not5xx(r), "POST /api/me/apply-seller does not 5xx", `HTTP ${r.status}`);
  if (already) skipped("apply-seller happy path", "already applied");
}

// ─────────────────────────────────────────────────────────────────────────────
section("3. Product CRUD (throwaway product, cleaned up)");

let storeUid = null;
{
  const r = await api("GET", "/api/my/store");
  ok(not5xx(r), "GET /api/my/store", `HTTP ${r.status}`);
  storeUid = r.json?.store?.uid ?? r.json?.uid ?? null;
  // Fall back to a real store uid from the DB so the public store pages are
  // probed with a value that actually exists (a hardcoded placeholder produced
  // a misleading 404 that looked like a broken route).
  if (!storeUid) {
    const rows = await db("stores?select=uid&limit=1");
    if (Array.isArray(rows) && rows[0]?.uid) storeUid = rows[0].uid;
  }
}

let productId = null;
const TITLE = `sweep-product-${Date.now()}`;
{
  // Real create schema (app/api/my/products/route.ts → createProduct):
  //   { name, category, delivery, price, glyph?, gradient?, img?, desc,
  //     notes?, warranty?, stockItems?, stock?, variants? }
  // NOTE: `title` is NOT a field — sending it yields "name is required".
  const r = await api("POST", "/api/my/products", {
    name: TITLE,
    category: "Digital Products",
    delivery: "instant",
    price: 1.5,
    desc: "temporary product created by product-pin-sweep",
    // Instant delivery requires at least one stock item (validated server-side:
    // "instant delivery requires at least 1 stock item").
    stockItems: [`sweep-stock-${Date.now()}`],
    stock: 3,
  });
  ok(not5xx(r), "POST /api/my/products (create)", `HTTP ${r.status}`);
  productId = r.json?.product?.id ?? r.json?.id ?? null;
  if (!productId) {
    const msg = JSON.stringify(r.json).slice(0, 100);
    skipped("product sub-routes", `create returned no id (HTTP ${r.status} ${msg})`);
  }
}

if (productId) {
  // Method map is deliberate — these routes export from `app/api/my/products`:
  //   [id]/route.ts          → PATCH, DELETE   (NO GET)
  //   [id]/variants/route.ts → PUT             (NO GET/POST)
  // Probing the unsupported verb yields 405, which is correct, not a bug.
  const r4 = await api("PATCH", `/api/my/products/${productId}`, {
    name: TITLE,
    desc: "temporary product updated by product-pin-sweep",
  });
  ok(not5xx(r4), "PATCH /api/my/products/:id (update)", `HTTP ${r4.status}`);

  const r3 = await api("PUT", `/api/my/products/${productId}/variants`, {
    variants: [{ name: "sweep-variant", price: 1.5, stock: 3 }],
  });
  ok(not5xx(r3), "PUT /api/my/products/:id/variants", `HTTP ${r3.status}`);

  const r5 = await api("PATCH", `/api/my/products/${productId}/status`, { status: "active" });
  ok(not5xx(r5), "PATCH /api/my/products/:id/status", `HTTP ${r5.status}`);

  // Restock body is { variantLabel?, items?: string[], stockQty?: number } and
  // requires items.length OR stockQty ("items or stockQty required").
  const r6 = await api("POST", `/api/my/products/${productId}/restock`, {
    items: [`sweep-restock-${Date.now()}`],
    stockQty: 1,
  });
  ok(not5xx(r6), "POST /api/my/products/:id/restock", `HTTP ${r6.status}`);

  // A GET on [id] has no handler → 405 is the correct answer. Assert it is
  // exactly 405 rather than silently accepting any non-5xx.
  const r7 = await api("GET", `/api/my/products/${productId}`);
  ok(r7.status === 405, "GET /api/my/products/:id → 405 (no GET handler)", `HTTP ${r7.status}`);

  // Ownership: another seller's product must be refused, never 5xx.
  // Use PATCH, not GET — [id] has no GET handler (405 would mask the real
  // ownership check and make the assertion meaningless).
  const others = await db("products?select=id,owner_user_id&limit=20");
  if (Array.isArray(others)) {
    const foreign = others.find((p) => p.owner_user_id && p.owner_user_id !== ME.id);
    if (foreign) {
      const rf = await api("PATCH", `/api/my/products/${foreign.id}`, { name: "hijacked" });
      ok(not5xx(rf) && rf.status >= 400, "PATCH another seller's product refused", `HTTP ${rf.status}`);
    } else {
      skipped("foreign product access", "no other seller's product found");
    }
  }

  // Cleanup
  const del = await api("DELETE", `/api/my/products/${productId}`);
  ok(not5xx(del), "DELETE /api/my/products/:id (cleanup)", `HTTP ${del.status}`);
  if (del.status >= 400) {
    // Fall back to a direct DB delete so the sweep leaves no litter.
    await dbWrite(`products?id=eq.${productId}`, "DELETE");
    const gone = await db(`products?select=id&id=eq.${productId}`);
    ok(Array.isArray(gone) && gone.length === 0, "throwaway product removed via DB", `${gone.length ?? "?"} left`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section("4. Public catalog reads");

{
  const r = await api("GET", "/api/products?limit=3");
  ok(not5xx(r), "GET /api/products", `HTTP ${r.status}`);
}
{
  const r = await api("GET", "/api/currencies");
  ok(not5xx(r), "GET /api/currencies", `HTTP ${r.status}`);
}
{
  const r = await api("GET", "/api/forum/channels");
  ok(not5xx(r), "GET /api/forum/channels", `HTTP ${r.status}`);
}
if (storeUid) {
  const r = await api("GET", `/api/stores/${storeUid}`);
  ok(not5xx(r), "GET /api/stores/:uid", `HTTP ${r.status}`);
  const r2 = await api("GET", `/api/stores/${storeUid}/reviews`);
  ok(not5xx(r2), "GET /api/stores/:uid/reviews", `HTTP ${r2.status}`);
} else {
  skipped("store pages", "no store uid");
}

// ─────────────────────────────────────────────────────────────────────────────
section("5. Admin gates — a Member must get 401/403, NEVER 5xx");

const ADMIN_ROUTES = [
  ["GET", "/api/admin/dashboard"],
  ["GET", "/api/admin/users"],
  ["GET", "/api/admin/stores"],
  ["GET", "/api/admin/products"],
  ["GET", "/api/admin/disputes"],
  ["GET", "/api/admin/fees"],
  ["GET", "/api/admin/audit-log"],
  ["GET", "/api/admin/reports"],
  ["GET", "/api/admin/middlemen"],
  ["GET", "/api/admin/wallet-txs"],
  ["GET", "/api/admin/sales-summary"],
  ["GET", "/api/admin/seller-applications"],
];
for (const [m, p] of ADMIN_ROUTES) {
  const r = await api(m, p);
  ok(r.status < 500 && (r.status === 401 || r.status === 403), `${m} ${p} → 401/403`, `HTTP ${r.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "-".repeat(74));
console.log(`PRODUCT / PIN / ADMIN-GATE — ${pass} ok / ${fail} failed / ${skip} skipped`);
console.log("-".repeat(74));
process.exit(fail === 0 ? 0 : 1);
