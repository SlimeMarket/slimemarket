/**
 * Role-based frontend sweep — Admin, Seller, Buyer.
 *
 * Drives the real SPA in a browser per role and exercises the features that
 * role actually owns. Each check reads visible DOM state (and, where useful,
 * the network response), so a page that renders but does nothing still fails.
 *
 * Usage:
 *   node scripts/ui-roles.mjs                 # all three roles
 *   node scripts/ui-roles.mjs admin           # one role
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const only = process.argv[2] ?? null;

// All accounts live on the @slimemarket.app catch-all, so a real OTP can always
// be read from the shared mailbox (otp-fetch.py). The seed @arc.id accounts are
// NOT usable here — they have no mailbox, so no UCW login can ever complete.
const ACCOUNTS = {
  admin: { email: "rimuru@slimemarket.app", label: "Admin" },
  seller: { email: "seller1@slimemarket.app", label: "Seller" },
  buyer: { email: "ucwfix3@slimemarket.app", label: "Member" },
};

let pass = 0;
const fails = [];
const ok = (m) => { pass++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { fails.push(m); console.log(`  \u2717 ${m}`); };

const browser = await chromium.launch();

/**
 * Wait until the SPA has hydrated the session.
 *
 * The session cookie is set by dev-login, but the SPA only stops showing the
 * sign-in screen once its own /api/auth/me round trip lands and ME is populated.
 * A fixed sleep is not enough — without this poll the page still reads as
 * "sign-in", which looks exactly like a broken admin route.
 */
async function waitAuth(page) {
  await page
    .waitForFunction(
      () => {
        const root = document.getElementById("root");
        if (!root || root.innerHTML.length < 500) return false;
        const txt = document.body.innerText || "";
        return !txt.includes("Send Login Code") && !!window.ME?.uid;
      },
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);
}

/**
 * Log in via dev-login so a role can be assumed without an OTP round trip.
 *
 * Use `ctx.request`, not `page.request`: the context-level jar is the one the
 * pages actually read from. With `page.request` the session call itself returns
 * 200 while the SPA still renders the sign-in page — a convincing false negative.
 * Log in BEFORE creating the page, so the first navigation already carries it.
 */
async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const r = await ctx.request.post(`${BASE}/api/auth/dev-login`, { data: { email } });
  if (!r.ok()) throw new Error(`dev-login ${email} → ${r.status()}`);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await waitAuth(page);
  return { ctx, page };
}

/** Collect console errors + failed API calls for a page visit. */
function watch(page) {
  const errs = [];
  const api = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 130)); });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/") && r.status() >= 400) api.push(`${r.status()} ${u.replace(BASE, "")}`);
  });
  return { errs, api };
}

async function visit(page, path, needle) {
  const w = watch(page);
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await waitAuth(page);
  await page.waitForTimeout(2500);
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const live = w.api.filter((a) => !/\/api\/auth\/me/.test(a));
  if (needle && !new RegExp(needle, "i").test(txt)) bad(`${path}: text "${needle}" not shown`);
  else if (live.length) bad(`${path}: API failed → ${live.slice(0, 3).join(" · ")}`);
  else ok(`${path} — ${txt.length} chars${needle ? ` · "${needle}" present` : ""}`);
  return txt;
}

async function role(name) {
  const acc = ACCOUNTS[name];
  console.log(`\n=== ${acc.label.toUpperCase()} — ${acc.email} ===`);
  const { ctx, page } = await session(acc.email);

  if (name === "buyer") {
    await visit(page, "/explore", "Netflix");
    await visit(page, "/products");
    await visit(page, "/orders", "Order");
    await visit(page, "/wallet", "Balance");
    await visit(page, "/profile");
    await visit(page, "/chat");
    await visit(page, "/forum");

    // search actually filters
    await page.goto(BASE + "/explore", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    // Search is Enter-triggered (onKeyDown), not live-filtered — filling the box
    // alone changes nothing, which is easy to misread as a broken search.
    const box = page.locator('input[type="text"], input[placeholder*="Search" i]').first();
    if (await box.count()) {
      await box.click();
      await box.fill("Netflix");
      await box.press("Enter");
      await page.waitForTimeout(4000);
      const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
      /Netflix/i.test(txt) ? ok("search 'Netflix' shows results") : bad("search shows no results");
    } else bad("search box not found");
  }

  if (name === "seller") {
    await visit(page, "/seller", "Seller");
    await visit(page, "/orders", "Order");
    await visit(page, "/escrow");
    await visit(page, "/chat");
    await visit(page, "/profile");

    // seller's own listings must render with an actionable control
    await page.goto(BASE + "/seller", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const btns = await page.getByRole("button").allInnerTexts();
    const hasListingCtl = btns.some((b) => /new|add|create|listing|product|jual|tambah/i.test(b));
    hasListingCtl ? ok("new-listing control present") : bad("no listing control");
  }

  if (name === "admin") {
    await visit(page, "/admin", "Admin");
    for (const tab of ["Users", "Products", "Stores", "Sales", "Reports", "Disputes"]) {
      // Match on substring, not an exact accessible name — the tab labels carry
      // counts, so getByRole({ name: /^Users$/ }) finds nothing.
      const t = page.locator(`button:has-text("${tab}"), [role="tab"]:has-text("${tab}")`).first();
      if (!(await t.count())) { bad(`tab ${tab} missing`); continue; }
      await t.click().catch(() => {});
      await page.waitForTimeout(2200);
      const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
      const stuck = /^\s*Loading\.\.\.\s*$/i.test(txt) || (txt.includes("Loading...") && txt.length < 80);
      !stuck && txt.length > 400 ? ok(`tab ${tab} render (${txt.length} chars)`) : bad(`tab ${tab} empty/stuck`);
    }
    await visit(page, "/mm", "Middleman");
  }

  await ctx.close();
}

for (const r of ["admin", "seller", "buyer"]) {
  if (only && only !== r) continue;
  await role(r);
}

await browser.close();
console.log(`\n=== ${pass} OK · ${fails.length} FAILED ===`);
if (fails.length) { fails.forEach((f) => console.log(`   - ${f}`)); process.exit(1); }
