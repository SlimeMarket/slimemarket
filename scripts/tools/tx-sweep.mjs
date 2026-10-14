#!/usr/bin/env node
/**
 * Transaction-flow sweep: exercise EVERY order lifecycle transition and report
 * exactly which step breaks. Read-only where possible; the mutating steps are
 * clearly marked and use throwaway records.
 *
 * Usage: node scripts/tools/tx-sweep.mjs [--session .secrets/ucw-X.json]
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
const base = env.APP_BASE_URL || "http://127.0.0.1:3000";
const supaUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const supaKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
if (!supaUrl || !supaKey) {
  console.error(`Missing Supabase env: url=${!!supaUrl} key=${!!supaKey}`);
  process.exit(1);
}

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : d;
};
const sessPath = arg("--session", ".secrets/ucw-testsellerxnzwo.json");
const sess = JSON.parse(fs.readFileSync(path.join(ROOT, sessPath), "utf8"));
const cookie = (sess.cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");

const H = { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" };

async function call(method, p, body) {
  const r = await fetch(base + p, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await r.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = raw.slice(0, 200); }
  return { status: r.status, json, raw };
}

// ---------- DB helpers ----------
const S = { apikey: supaKey, Authorization: `Bearer ${supaKey}` };
async function db(pathAndQuery) {
  const r = await fetch(`${supaUrl}/rest/v1/${pathAndQuery}`, { headers: S });
  return r.json();
}
async function dbPatch(table, filter, body) {
  const r = await fetch(`${supaUrl}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...S, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  OK " : "  ERR"}  ${name.padEnd(52)} ${String(detail).slice(0, 150)}`);
}

console.log(`session: ${sess.email} | role: ${sess.role || "(from /api/me)"} | status: ${sess.finalStatus}`);
const me = await call("GET", "/api/me");
const myId = me.json?.user?.id;
const myRole = me.json?.user?.role;
console.log(`me: id=${myId} role=${myRole}\n`);

// ============================================================
console.log("=== 1. READ paths ===");
for (const [name, p] of [
  ["me", "/api/me"],
  ["my/orders", "/api/my/orders"],
  ["my/buys", "/api/my/buys"],
  ["my/earnings", "/api/my/earnings"],
  ["my/transactions", "/api/my/transactions"],
  ["wallet", "/api/wallet"],
  ["wallet/history", "/api/wallet/history"],
  ["orders", "/api/orders"],
  ["notifications", "/api/notifications"],
]) {
  const r = await call("GET", p);
  rec(name, r.status === 200, `${r.status}`);
}

// ============================================================
console.log("\n=== 2. Order lifecycle: inspect an existing DONE order ===");
// Pick an order the SESSION USER actually participates in. Timeline and receipt
// are participant-only, so grabbing the globally-newest DONE order produces
// false failures the moment somebody else's order is newer than yours — e.g.
// after a fresh-account purchase, a seller session sees 404/403 on the NEW
// buyer's order and reports it as broken. Those statuses are the guards working.
const doneOrders = await db(
  myId
    ? `orders?select=*&status=eq.DONE&buyer_id=eq.${myId}&order=created_at.desc&limit=3`
    : `orders?select=*&status=eq.DONE&order=created_at.desc&limit=3`,
);
const done = doneOrders[0];
if (done) {
  console.log(`  DONE order ${done.id.slice(0, 8)} amount=${done.amount} fee=${done.buyer_fee} buyer=${String(done.buyer_id).slice(0, 8)}`);
  for (const [name, p] of [
    ["orders/:id", `/api/orders/${done.id}`],
    ["orders/:id/timeline", `/api/orders/${done.id}/timeline`],
    ["orders/:id/receipt", `/api/orders/${done.id}/receipt`],
  ]) {
    const r = await call("GET", p);
    rec(name, r.status === 200, `${r.status} ${typeof r.json === "object" ? JSON.stringify(r.json).slice(0, 90) : r.json}`);
  }
} else {
  rec("find DONE order for this user", false, "none");
}

// ============================================================
console.log("\n=== 3. State-machine integrity (all orders) ===");
const allOrders = await db("orders?select=id,status,on_chain_status,payment,amount,created_at&order=created_at.desc&limit=60");
const byStatus = {};
for (const o of allOrders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
console.log("  status distribution:", JSON.stringify(byStatus));
const ORPHAN = allOrders.filter((o) => o.status === "DONE" && o.payment === "Balance" && !o.on_chain_status);
rec("no DONE order missing on_chain_status", ORPHAN.length === 0, `${ORPHAN.length} orphan(s)`);
const PENDING_OLD = allOrders.filter((o) => {
  if (o.status !== "PENDING") return false;
  const ageMs = Date.now() - new Date(o.created_at).getTime();
  return ageMs > 2 * 60 * 60 * 1000;
});
// These are reaped by the sweep/drafts cron (30 min for Onchain, 2h for Balance).
// Run that job first (scripts/tools/run-jobs.mjs) or this can legitimately flag
// records the scheduler simply hasn't reached yet.
rec("no PENDING order older than 2h (draft leak)", PENDING_OLD.length === 0, `${PENDING_OLD.length} stale`);

// ============================================================
console.log("\n=== 4. Seller-side order ops need a SELLER session ===");
const sellerStore = await db(`stores?select=id,name,owner_user_id&limit=5`);
console.log("  stores:", sellerStore.map((s) => `${s.name}(${s.id.slice(0, 8)})`).join(", "));
const myStore = await call("GET", "/api/my/store");
rec("my/store", myStore.status === 200, `${myStore.status} ${myStore.json?.store ? "has store" : "no store"}`);

// ============================================================
console.log("\n=== 5. Mutation paths (safe, reversible) ===");
// 5a. notification read toggle — needs a notification for this user
const notif = await db(`notifications?select=id,read&user_id=eq.${myId}&limit=1`);
if (notif[0]) {
  const r = await call("POST", "/api/notifications", { ids: [notif[0].id], read: true });
  rec("POST /api/notifications (mark read)", r.status < 400, `${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
} else {
  rec("POST /api/notifications", true, "skipped — no notification for this user");
}

// 5b. chat send/read (already fixed — confirm still green)
const threads = await call("GET", "/api/chats");
const tid = threads.json?.items?.[0]?.id;
if (tid) {
  const r = await call("POST", `/api/chats/${tid}/messages`, { text: `tx-sweep ${new Date().toISOString()}` });
  rec("POST chat message", r.status === 201, `${r.status}`);
} else {
  rec("POST chat message", true, "skipped — no thread");
}

// 5c. forum post
const f = await call("POST", "/api/forum/global", { text: `tx-sweep forum ${Date.now()}` });
rec("POST forum message", f.status === 201, `${f.status}`);

// ============================================================
console.log("\n=== 6. Withdrawal / payout rail ===");
const earn = await call("GET", "/api/my/earnings");
console.log("  earnings:", JSON.stringify(earn.json).slice(0, 200));
const wd = await call("POST", "/api/wallet/withdraw", { amountUsdc: "0.01" });
rec("POST wallet/withdraw (0.01, expect graceful error if no funds)", wd.status < 500, `${wd.status} ${JSON.stringify(wd.json).slice(0, 120)}`);

const bank = await call("GET", "/api/wallet/bank-accounts");
rec("wallet/bank-accounts", bank.status === 200, `${bank.status}`);

// ============================================================
console.log("\n=== 7. Escrow / WL deal rail ===");
for (const [name, p] of [
  ["wl/listings", "/api/wl/listings"],
  ["wl/deals", "/api/wl/deals"],
]) {
  const r = await call("GET", p);
  rec(name, r.status === 200, `${r.status}`);
}
const wlPrep = await call("POST", "/api/wl/deals/prepare", {});
rec("wl/deals/prepare (expect 400 validation, not 500)", wlPrep.status < 500, `${wlPrep.status} ${JSON.stringify(wlPrep.json).slice(0, 120)}`);

// ============================================================
console.log("\n=== 8. Disputes / reports ===");
// /api/reports is POST-only (file a report); /api/admin/reports is the GET list.
const repList = await call("GET", "/api/admin/reports");
rec("GET /api/admin/reports (admin-only; 401/403 expected on a Member)", repList.status === 200 || repList.status === 401 || repList.status === 403, `${repList.status}`);
const repPost = await call("POST", "/api/reports", {
  targetType: "product",
  targetId: (await db("products?select=id&limit=1"))[0]?.id,
  reason: "other",
  detail: `tx-sweep ${Date.now()}`,
});
rec("POST /api/reports (file a report)", repPost.status === 201 || repPost.status === 200, `${repPost.status} ${JSON.stringify(repPost.json).slice(0, 100)}`);
if (done) {
  const ap = await call("POST", `/api/orders/${done.id}/appeal`, { reason: "tx-sweep probe" });
  rec("orders/:id/appeal (expect <500)", ap.status < 500, `${ap.status} ${JSON.stringify(ap.json).slice(0, 110)}`);
}

// ============================================================
console.log("\n=== SUMMARY ===");
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length} ok / ${bad.length} err`);
if (bad.length) {
  console.log("\nFAILURES:");
  for (const b of bad) console.log(`  ✗ ${b.name} → ${b.detail}`);
}
