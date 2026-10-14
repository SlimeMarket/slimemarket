#!/usr/bin/env node
/**
 * Local smoke test — verifies the core functions of every role against a
 * running local dev server. Read-mostly: it only WRITES the minimum needed
 * (a seller store + one product + a small faucet top-up) so the buyer/MM paths
 * have something to see.
 *
 * Usage:
 *   node scripts/smoke-local.mjs
 *   SMOKE_BASE_URL=http://localhost:3001 node scripts/smoke-local.mjs
 *
 * Requires the dev server to be running (npm run dev) and NODE_ENV != production
 * (dev-login is 404 in production).
 *
 * Exit code: 0 if no FAIL, 1 otherwise.
 */

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const PASS = "\u2713", FAIL = "\u2717", SKIP = "\u2013";

const results = [];
function rec(area, name, ok, detail = "") {
  results.push({ area, name, ok, detail });
  const tag = ok === "skip" ? SKIP : ok ? PASS : FAIL;
  console.log(`  ${tag} ${name}${detail ? "  — " + detail : ""}`);
}

async function devLogin(email, role) {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error(`dev-login ${email} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function client(jar) {
  return async (path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (jar) headers.cookie = jar;
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    return fetch(`${BASE}${path}`, { ...opts, headers });
  };
}

async function expectOk(c, path, { method = "GET", body, allow = [] } = {}) {
  const res = await c(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (res.ok) return { ok: true, detail: `${res.status}` };
  if (allow.includes(res.status)) return { ok: "skip", detail: `${res.status} (allowed)` };
  let snippet = "";
  try { snippet = (await res.text()).slice(0, 160).replace(/\s+/g, " "); } catch {}
  return { ok: false, detail: `${res.status} ${snippet}` };
}

async function check(area, name, fn) {
  try {
    const r = await fn();
    if (r === "skip") return rec(area, name, "skip");
    if (r && r.ok === true) return rec(area, name, true, r.detail || "");
    if (r && r.ok === "skip") return rec(area, name, "skip", r.detail || "");
    return rec(area, name, false, (r && r.detail) || "no detail");
  } catch (e) {
    return rec(area, name, false, `EXCEPTION: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log(`\nSlimeMarket local smoke test  →  ${BASE}\n`);

try {
  const h = await fetch(`${BASE}/api/health`);
  console.log(`health: HTTP ${h.status}\n`);
} catch {
  console.error(`Server not reachable at ${BASE} — start it with 'npm run dev'.`);
  process.exit(2);
}

// 1. accounts
const ACC = {
  buyer: { email: "smoke-buyer@slimemarket.app", role: "Buyer" },
  seller: { email: "smoke-seller@slimemarket.app", role: "Seller" },
  mm: { email: "smoke-mm@slimemarket.app", role: "MM" },
  admin: { email: "rimuru@slimemarket.app", role: "Admin" },
};

console.log("== Auth / sessions ==");
const jars = {};
for (const [key, { email, role }] of Object.entries(ACC)) {
  try {
    jars[key] = await devLogin(email, role);
    rec("auth", `dev-login ${key} (${email} as ${role})`, true);
  } catch (e) {
    rec("auth", `dev-login ${key} (${email} as ${role})`, false, e.message);
  }
}
const anon = client(null);
const buyer = client(jars.buyer), seller = client(jars.seller), mm = client(jars.mm), admin = client(jars.admin);

await check("auth", "GET /api/auth/me (buyer)", () => expectOk(buyer, "/api/auth/me"));
await check("auth", "GET /api/auth/me (seller)", () => expectOk(seller, "/api/auth/me"));
await check("auth", "GET /api/auth/me (mm)", () => expectOk(mm, "/api/auth/me"));
await check("auth", "GET /api/auth/me (admin)", () => expectOk(admin, "/api/auth/me"));

// 2. storefront (public + session-gated extras via admin)
console.log("\n== Storefront ==");
await check("storefront", "GET /config.js", () => expectOk(anon, "/config.js"));
await check("storefront", "GET /api/products", () => expectOk(anon, "/api/products"));
await check("storefront", "GET /api/forum/channels (admin)", () => expectOk(admin, "/api/forum/channels"));
await check("storefront", "GET /api/sales/recent (admin)", () => expectOk(admin, "/api/sales/recent"));
await check("storefront", "GET /api/sales/stats (admin)", () => expectOk(admin, "/api/sales/stats"));

// 3. seller — GET auto-provisions the store; then create a product and read back
console.log("\n== Seller ==");
await check("seller", "GET  /api/my/store (auto-provision)", () => expectOk(seller, "/api/my/store"));

let productId = null;
await check("seller", "POST /api/my/products (create product)", async () => {
  const r = await seller("/api/my/products", {
    method: "POST",
    body: JSON.stringify({
      name: "Smoke Test Item",
      category: "Digital Products",
      delivery: "instant",
      price: 1,
      desc: "Created by scripts/smoke-local.mjs",
      stockItems: ["smoke-key-1", "smoke-key-2", "smoke-key-3"],
      stock: 3,
    }),
  });
  if (r.ok) {
    const j = await r.json().catch(() => ({}));
    productId = j?.id ?? j?.data?.id ?? j?.item?.id ?? null;
    return { ok: true, detail: `id=${productId ?? "?"}` };
  }
  const txt = (await r.text()).slice(0, 200);
  // 409/400 "already exists" is fine — reuse whatever is in the catalog.
  if (r.status === 409 || /already/i.test(txt)) return { ok: "skip", detail: `${r.status} (exists)` };
  return { ok: false, detail: `${r.status} ${txt}` };
});
if (!productId) {
  const list = await (await anon("/api/products")).json().catch(() => ({}));
  const items = list?.items ?? list?.data?.items ?? [];
  productId = items[0]?.id ?? null;
  if (productId) rec("seller", "  (reused existing product)", true, `id=${productId}`);
}

await check("seller", "GET  /api/my/products", () => expectOk(seller, "/api/my/products"));
await check("seller", "GET  /api/my/earnings", () => expectOk(seller, "/api/my/earnings"));
await check("seller", "POST /api/my/sales-summary", () => expectOk(seller, "/api/my/sales-summary", { method: "POST" }));
await check("seller", "GET  /api/my/orders", () => expectOk(seller, "/api/my/orders"));

// 4. buyer
console.log("\n== Buyer ==");
await check("buyer", "GET  /api/wallet", () => expectOk(buyer, "/api/wallet"));
await check("buyer", "GET  /api/wallet/history", () => expectOk(buyer, "/api/wallet/history"));
await check("buyer", "GET  /api/my/buys", () => expectOk(buyer, "/api/my/buys"));
await check("buyer", "GET  /api/orders", () => expectOk(buyer, "/api/orders"));
await check("buyer", "GET  /api/my/transactions", () => expectOk(buyer, "/api/my/transactions"));
await check("buyer", "GET  /api/notifications", () => expectOk(buyer, "/api/notifications"));
await check("buyer", "GET  /api/my/pin-status", () => expectOk(buyer, "/api/my/pin-status"));
await check("buyer", "POST /api/wallet/dev/faucet (top up 1 USDC)", async () => {
  const r = await buyer("/api/wallet/dev/faucet", {
    method: "POST",
    body: JSON.stringify({ amountUsdc: "1" }),
  });
  if (r.ok) return { ok: true, detail: `${r.status}` };
  const body = await r.text().catch(() => "");
  // 402 = the platform treasury wallet has no testnet USDC left (the dev faucet
  // moves REAL USDC). That is an environment state, not a code defect.
  if (r.status === 402 || /insufficient/i.test(body)) {
    return { ok: "skip", detail: "treasury DCW out of USDC — top up from faucet.circle.com" };
  }
  return { ok: false, detail: `${r.status} ${body.slice(0, 140)}` };
});
if (productId) {
  await check("buyer", "POST /api/orders/checkout/prepare", () =>
    expectOk(buyer, "/api/orders/checkout/prepare", {
      method: "POST",
      body: { productId, variantLabel: "Default", qty: 1 },
      allow: [400, 409, 422],
    }));
} else {
  rec("buyer", "POST /api/orders/checkout/prepare", "skip", "no product id");
}

// 5. MM (middleman / rekber)
console.log("\n== MM (rekber) ==");
await check("mm", "GET  /api/wl/listings", () => expectOk(mm, "/api/wl/listings"));
await check("mm", "GET  /api/wl/deals", () => expectOk(mm, "/api/wl/deals"));
await check("mm", "GET  /api/chats", () => expectOk(mm, "/api/chats"));

// 6. admin
console.log("\n== Admin ==");
const adminGets = [
  "/api/admin/dashboard", "/api/admin/users", "/api/admin/stores", "/api/admin/products",
  "/api/admin/treasury", "/api/admin/fees", "/api/admin/disputes", "/api/admin/reports",
  "/api/admin/middlemen", "/api/admin/seller-applications", "/api/admin/audit",
  "/api/admin/audit-log", "/api/admin/wallet-txs", "/api/admin/sales-summary",
  "/api/admin/mm", "/api/admin/mm/stats",
];
for (const p of adminGets) await check("admin", `GET  ${p}`, () => expectOk(admin, p));
await check("admin", "POST /api/admin/verify", () => expectOk(admin, "/api/admin/verify", { method: "POST", body: {}, allow: [400, 422] }));

// 7. authz guards — a non-admin must get 401/403 (never 500) on every admin route
console.log("\n== Authz guards (buyer → admin routes must be 401/403) ==");
for (const p of adminGets) {
  await check("authz", `buyer → ${p}`, async () => {
    const r = await buyer(p);
    if ([401, 403].includes(r.status)) return { ok: true, detail: `${r.status}` };
    return { ok: false, detail: `got ${r.status} (expected 401/403)` };
  });
}
await check("authz", "anonymous → /api/orders must be 401/403", async () => {
  const r = await anon("/api/orders");
  return [401, 403].includes(r.status) ? { ok: true, detail: `${r.status}` } : { ok: false, detail: `got ${r.status}` };
});

// ---------------------------------------------------------------------------
const fails = results.filter((r) => r.ok === false);
const passes = results.filter((r) => r.ok === true).length;
const skips = results.filter((r) => r.ok === "skip").length;

console.log("\n" + "-".repeat(64));
console.log(`RESULT: ${passes} pass, ${fails.length} fail, ${skips} skip`);
if (fails.length) {
  console.log("\nFAILURES:");
  for (const f of fails) console.log(`  [${f.area}] ${f.name} — ${f.detail}`);
}
console.log("-".repeat(64) + "\n");
process.exit(fails.length ? 1 : 0);
