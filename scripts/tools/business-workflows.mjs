#!/usr/bin/env node
/**
 * business-workflows.mjs — exercise business flows the order/chat sweeps never
 * touched: reviews, referral, notifications read, and the appeal/dispute guard
 * rails. Read-mostly; mutations are clearly marked and use real data.
 *
 * Usage: node scripts/tools/business-workflows.mjs --buyer .secrets/ucw-X.json
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = (arg("--base", process.env.WF_BASE || "http://localhost:3000")).replace(/\/$/, "");
const sessPath = arg("--buyer", ".secrets/ucw-testsellerxnzwo.json");

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
const DB = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function db(q) {
  const r = await fetch(`${SUPA}/rest/v1/${q}`, { headers: DB });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t.slice(0, 200); }
}

const sess = JSON.parse(fs.readFileSync(path.join(ROOT, sessPath), "utf8"));
const COOKIE = (sess.cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");

let pass = 0, fail = 0, skip = 0;
const ok = (c, label, detail = "") => {
  if (c) { pass++; console.log(`  \u2713 ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  \u2717 ${label}${detail ? " — " + detail : ""}`); }
};
const skipped = (label, why) => { skip++; console.log(`  \u25CB ${label} — skipped (${why})`); };

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      Cookie: COOKIE, Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json", Origin: BASE, Referer: BASE + "/" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await r.text();
  let json; try { json = JSON.parse(raw); } catch { json = raw.slice(0, 200); }
  return { status: r.status, ok: r.ok, json };
}

console.log(`\nBUSINESS WORKFLOWS  →  ${BASE}   (${sessPath})`);
console.log("=".repeat(74));

const me = await api("GET", "/api/auth/me");
const myId = me.json?.user?.id ?? me.json?.id;
console.log(`  user — ${me.json?.user?.email ?? me.json?.email}  id=${String(myId).slice(0, 8)}\n`);
if (!myId) { console.error("session invalid"); process.exit(2); }

// --- 1. a DONE order I bought → review it ------------------------------------
console.log("[1] review a completed order (buyer side)");
{
  const done = await db(`orders?select=id,status,buyer_id,store_id&buyer_id=eq.${myId}&status=eq.DONE&order=created_at.desc&limit=1`);
  if (!Array.isArray(done) || !done[0]) {
    skipped("review flow", "no DONE order for this buyer");
  } else {
    const orderId = done[0].id;
    const existing = await db(`reviews?select=id&order_id=eq.${orderId}`);
    if (Array.isArray(existing) && existing.length) {
      skipped("review insert", "already reviewed (unique constraint)");
      // Idempotency: a second attempt must be refused, not duplicated.
      const dup = await api("POST", `/api/orders/${orderId}/review`, { rating: 5, comment: "dup" });
      ok(dup.status === 400, "duplicate review refused", `HTTP ${dup.status}`);
    } else {
      const r = await api("POST", `/api/orders/${orderId}/review`, { rating: 5, comment: "workflow test" });
      ok(r.status === 200, "POST review on DONE order", `HTTP ${r.status}`);
      const back = await db(`reviews?select=id,rating,store_id,display_name&order_id=eq.${orderId}`);
      ok(Array.isArray(back) && back.length === 1, "review persisted once", `${Array.isArray(back) ? back.length : "?"} row(s)`);
      if (back?.[0]) console.log(`      rating=${back[0].rating} store=${String(back[0].store_id).slice(0, 8)} name=${back[0].display_name}`);
    }
    // Guard: rating out of range
    const bad = await api("POST", `/api/orders/${orderId}/review`, { rating: 9 });
    ok(bad.status === 400, "rating > 5 refused", `HTTP ${bad.status}`);
  }
}

// --- 2. reviews are publicly readable on the store ---------------------------
console.log("\n[2] store reviews are readable");
{
  const stores = await db("stores?select=id,uid,name&limit=5");
  if (!Array.isArray(stores) || !stores[0]) skipped("store reviews", "no stores");
  else {
    const s = stores.find((x) => x.uid) || stores[0];
    const r = await api("GET", `/api/stores/${s.uid}/reviews`);
    ok(r.ok, `GET /api/stores/${s.uid}/reviews`, `HTTP ${r.status}`);
  }
}

// --- 3. referral code + link -------------------------------------------------
console.log("\n[3] referral");
{
  // GET returns `{code: null}` when the user never generated one — that is the
  // documented shape (see app/api/referral/route.ts), not a failure. Issue one
  // via POST first so the happy path is actually exercised.
  let r = await api("GET", "/api/referral");
  ok(r.ok, "GET /api/referral", `HTTP ${r.status}`);
  if (!r.json?.code) r = await api("POST", "/api/referral", {});
  ok(r.ok, "POST /api/referral issues code", `HTTP ${r.status}`);
  const code = r.json?.code ?? r.json?.referralCode;
  ok(!!code, "referral code present", String(code ?? ""));
  const link = r.json?.link;
  ok(!!link && String(link).includes(code ?? "\u0000"), "referral link matches code", String(link ?? ""));
  const rows = await db(`referrals?select=user_id,code&user_id=eq.${myId}`);
  const dbCode = Array.isArray(rows) ? rows[0]?.code : null;
  ok(!!dbCode && dbCode === code, "code persisted in referrals table", String(dbCode ?? ""));
}

// --- 4. notifications read ---------------------------------------------------
console.log("\n[4] notifications");
{
  const r = await api("GET", "/api/notifications");
  const items = r.json?.items ?? r.json;
  ok(r.ok, "GET /api/notifications", `HTTP ${r.status}, ${Array.isArray(items) ? items.length : "?"} item(s)`);
  const rows = await db(`notifications?select=id&user_id=eq.${myId}`);
  ok(Array.isArray(rows), "notifications table readable for user", `${Array.isArray(rows) ? rows.length : "?"} row(s)`);
}

// --- 5. appeal only valid on SENT (guard rail) -------------------------------
console.log("\n[5] appeal guard rail");
{
  const done = await db(`orders?select=id,status&buyer_id=eq.${myId}&status=eq.DONE&limit=1`);
  if (!Array.isArray(done) || !done[0]) skipped("appeal guard", "no DONE order");
  else {
    const r = await api("POST", `/api/orders/${done[0].id}/appeal`, { reason: "test" });
    ok(r.status >= 400 && r.status < 500, "appeal on DONE refused (not 5xx)", `HTTP ${r.status}`);
  }
}

// --- 6. cannot review someone else's order -----------------------------------
console.log("\n[6] ownership guard — reviewing a stranger's order");
{
  const others = await db(`orders?select=id,status&buyer_id=neq.${myId}&status=eq.DONE&limit=1`);
  if (!Array.isArray(others) || !others[0]) skipped("ownership guard", "no foreign DONE order");
  else {
    const r = await api("POST", `/api/orders/${others[0].id}/review`, { rating: 5, comment: "x" });
    ok(r.status === 400 || r.status === 403, "foreign order review refused", `HTTP ${r.status}`);
  }
}

console.log("\n" + "-".repeat(74));
console.log(`BUSINESS WORKFLOWS — ${pass} ok / ${fail} failed / ${skip} skipped`);
console.log("-".repeat(74) + "\n");
process.exit(fail === 0 ? 0 : 1);
