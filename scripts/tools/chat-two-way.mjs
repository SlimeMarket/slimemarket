#!/usr/bin/env node
/**
 * chat-two-way.mjs — prove seller↔buyer chat works BOTH directions.
 *
 * Creates (or reuses) a DM thread between a seller session and a buyer session,
 * then exercises:
 *   1. seller → buyer  message
 *   2. buyer  → seller reply
 *   3. both sides can LIST the thread
 *   4. both sides can READ the messages (and see each other's text)
 *   5. the stored sender_role is a value the CHECK constraint accepts
 *   6. thread last_text/last_time advanced
 *
 * Usage: node scripts/tools/chat-two-way.mjs --seller .secrets/ucw-A.json --buyer .secrets/ucw-B.json
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = (arg("--base", process.env.CHAT_BASE || "http://localhost:3000")).replace(/\/$/, "");

const sellerSession = arg("--seller");
const buyerSession = arg("--buyer");
if (!sellerSession || !buyerSession) {
  console.error("need --seller <session.json> --buyer <session.json>");
  process.exit(2);
}

function loadSession(p) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
  return {
    cookie: (s.cookies || []).map((c) => `${c.name}=${c.value}`).join("; "),
    email: s.email,
    wallet: s.walletAddress,
    userToken: s.userToken,
  };
}

/** Minimal .env.local reader (node -e can't load env; script files can). */
function loadEnvFile() {
  const p = path.join(ROOT, ".env.local");
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
const seller = loadSession(sellerSession);
const buyer = loadSession(buyerSession);

const ALLOWED_ROLES = new Set(["buyer", "seller", "middleman", "system", "admin"]);

let pass = 0, fail = 0;
const ok = (c, label, detail = "") => {
  if (c) { pass++; console.log(`  \u2713 ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  \u2717 ${label}${detail ? " — " + detail : ""}`); }
};

async function api(who, method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      Cookie: who.cookie,
      "Content-Type": "application/json",
      Origin: BASE,
      Referer: BASE + "/",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await r.text();
  let json; try { json = JSON.parse(raw); } catch { json = raw.slice(0, 200); }
  return { status: r.status, ok: r.ok, json };
}

console.log(`\nCHAT TWO-WAY  →  ${BASE}`);
console.log("=".repeat(66));
console.log(`  seller — ${seller.email}`);
console.log(`  buyer  — ${buyer.email}\n`);

// --- resolve identities ------------------------------------------------------
const meSeller = await api(seller, "GET", "/api/auth/me");
const meBuyer = await api(buyer, "GET", "/api/auth/me");
if (!meSeller.ok || !meBuyer.ok) {
  console.error(`session invalid: seller=${meSeller.status} buyer=${meBuyer.status}`);
  process.exit(2);
}
const sellerId = meSeller.json.user?.id ?? meSeller.json.id;
const buyerId = meBuyer.json.user?.id ?? meBuyer.json.id;
console.log(`  sellerId=${String(sellerId).slice(0, 8)} role=${meSeller.json.user?.role ?? meSeller.json.role}`);
console.log(`  buyerId =${String(buyerId).slice(0, 8)} role=${meBuyer.json.user?.role ?? meBuyer.json.role}\n`);

// --- 1. seller opens the thread toward the buyer -----------------------------
console.log("[1] seller opens a DM thread → buyer");
let threadId = null;
{
  const stamp = Date.now();
  const r = await api(seller, "POST", "/api/chats", {
    participantId: buyerId,
    type: "normal",
    initialMessage: `SELLER→BUYER hi this is message #1 (${stamp})`,
  });
  ok(r.status === 201, "POST /api/chats (as seller)", `HTTP ${r.status}`);
  threadId = r.json?.id ?? null;
  ok(!!threadId, "thread id returned", String(threadId).slice(0, 8));
}

// --- 2. seller sends a follow-up ---------------------------------------------
// NOTE on response shape: POST /messages returns the mapped message whose
// `from` field is "me" (the caller's own view). It does NOT echo sender_role —
// the CHECK-constraint-safe role is verified against the DB in step 9 instead.
console.log("\n[2] seller → buyer (follow-up)");
{
  const r = await api(seller, "POST", `/api/chats/${threadId}/messages`, {
    text: "SELLER→BUYER message #2, stock still available",
  });
  ok(r.status === 201, "POST messages (seller)", `HTTP ${r.status}`);
  ok(r.json?.from === "me", "sender sees own msg as 'me'", `from=${r.json?.from}`);
}

// --- 3. buyer replies --------------------------------------------------------
console.log("\n[3] buyer → seller (reply)");
{
  const r = await api(buyer, "POST", `/api/chats/${threadId}/messages`, {
    text: "BUYER→SELLER ok I'll take 1",
  });
  ok(r.status === 201, "POST messages (buyer)", `HTTP ${r.status}`);
  ok(r.json?.from === "me", "buyer sees own msg as 'me'", `from=${r.json?.from}`);
}

// --- 4. seller sends again (round-trip) --------------------------------------
console.log("\n[4] seller → buyer (round-trip)");
{
  const r = await api(seller, "POST", `/api/chats/${threadId}/messages`, {
    text: "SELLER→BUYER ok, please checkout",
  });
  ok(r.status === 201, "POST messages (seller, 2nd)", `HTTP ${r.status}`);
}

// --- 5. both sides see the thread in their list ------------------------------
console.log("\n[5] both sides LIST the thread");
for (const [who, label] of [[seller, "seller"], [buyer, "buyer"]]) {
  const r = await api(who, "GET", "/api/chats");
  const items = r.json?.items ?? [];
  const found = items.find((t) => t.id === threadId);
  ok(r.ok && !!found, `${label} GET /api/chats contains thread`, `HTTP ${r.status}, ${items.length} thread(s)`);
  // Thread rows use: user/avatar/role/uid for the partner, last/lastTime for the preview.
  if (found) ok(!!found.user, `  └ partner resolved`, String(found.user ?? "(none)"));
}

// --- 6. both sides READ the history ------------------------------------------
console.log("\n[6] both sides READ the messages");
for (const [who, label] of [[seller, "seller"], [buyer, "buyer"]]) {
  const r = await api(who, "GET", `/api/chats/${threadId}`);
  const msgs = r.json?.messages ?? [];
  ok(r.ok, `${label} GET /api/chats/:id`, `HTTP ${r.status}, ${msgs.length} message(s)`);
  const texts = msgs.map((m) => m.text ?? "");
  ok(texts.some((t) => t.startsWith("SELLER→BUYER")), `  └ ${label} sees SELLER→BUYER`);
  ok(texts.some((t) => t.startsWith("BUYER→SELLER")), `  └ ${label} sees BUYER→SELLER`);
  // `from` is rendered per-viewer: the reader's own messages must say "me".
  const mine = msgs.filter((m) => m.from === "me").map((m) => m.text ?? "");
  const ownPrefix = label === "seller" ? "SELLER→BUYER" : "BUYER→SELLER";
  ok(mine.length > 0 && mine.every((t) => t.startsWith(ownPrefix)),
    `  └ ${label} own msgs flagged "me"`, `${mine.length} own`);
}

// --- 7. thread preview advanced ----------------------------------------------
console.log("\n[7] thread preview advanced");
{
  const r = await api(seller, "GET", "/api/chats");
  const found = (r.json?.items ?? []).find((t) => t.id === threadId);
  ok(!!found?.last, "last preview set", String(found?.last ?? ""));
  ok(!!found?.lastTime, "lastTime set", String(found?.lastTime ?? ""));
}

// --- 8. stranger cannot read it ----------------------------------------------
console.log("\n[8] access control — non-participant is denied");
{
  const r = await fetch(`${BASE}/api/chats/${threadId}`, { headers: { Accept: "application/json" } });
  const t = await r.text();
  const body = t.trim().startsWith("{") ? JSON.parse(t) : null;
  const denied = r.status === 401 || (body && (body.messages ?? []).length === 0);
  ok(denied, "anonymous GET /api/chats/:id denied", `HTTP ${r.status}`);
}

// --- 9. verify the STORED sender_role against the DB -------------------------
// The API maps roles for display; the constraint-safe value lives in the column.
console.log("\n[9] stored sender_role (direct DB read)");
{
  const env = loadEnvFile();
  const supaUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  if (!supaUrl || !supaKey) {
    ok(false, "Supabase env available for DB check", "missing SUPABASE_URL / SERVICE_ROLE_KEY");
  } else {
    const h = { apikey: supaKey, Authorization: `Bearer ${supaKey}` };
    const r = await fetch(
      `${supaUrl}/rest/v1/chat_messages?select=sender_id,sender_role,text&thread_id=eq.${threadId}&order=created_at.asc`,
      { headers: h },
    );
    const rows = await r.json();
    if (!Array.isArray(rows)) {
      ok(false, "chat_messages readable", JSON.stringify(rows).slice(0, 120));
    } else {
      const bad = rows.filter((m) => !ALLOWED_ROLES.has(m.sender_role));
      ok(bad.length === 0, "every stored sender_role passes the CHECK constraint",
        bad.length ? `bad: ${JSON.stringify(bad.map((b) => b.sender_role))}` : `${rows.length} rows`);
      const sellerRows = rows.filter((m) => m.text.startsWith("SELLER→BUYER"));
      const buyerRows = rows.filter((m) => m.text.startsWith("BUYER→SELLER"));
      ok(sellerRows.length === 3, "3 seller messages persisted", `${sellerRows.length}`);
      ok(buyerRows.length === 1, "1 buyer message persisted", `${buyerRows.length}`);
      // Both senders used the SAME table but different sender_id — prove it.
      const ids = new Set(rows.map((m) => m.sender_id));
      ok(ids.size === 2, "two distinct sender_ids present", `${ids.size}`);
      console.log(`      roles seen: ${[...new Set(rows.map((m) => m.sender_role))].join(", ")}`);
    }
  }
}

console.log("\n" + "-".repeat(66));
console.log(`${fail === 0 ? "CHAT TWO-WAY OK" : "CHAT TWO-WAY HAS FAILURES"} — ${pass} ok / ${fail} failed`);
console.log("-".repeat(66) + "\n");
process.exit(fail === 0 ? 0 : 1);
