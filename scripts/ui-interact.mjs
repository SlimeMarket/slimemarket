/**
 * UI interaction test — drive the app the way a person does.
 *
 * `ui-smoke.mjs` proves each page renders. It says nothing about whether the
 * controls work: a button can render perfectly and still call the wrong
 * endpoint, submit nothing, or leave the UI in a state that never resolves.
 * So this clicks real elements and asserts on what actually changes.
 *
 * Every check records a named PASS/FAIL so a broken step is obvious, rather
 * than one opaque failure at the end.
 *
 * Usage: node scripts/ui-interact.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SHOT_DIR = ".secrets/_ui-shots";
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
};

/** Wait until the app has restored its session and rendered. */
async function waitReady(page, { expectAuth = false } = {}) {
  await page.waitForFunction(
    (auth) => {
      const root = document.getElementById("root");
      if (!root || root.innerHTML.length < 500) return false;
      const txt = document.body.innerText || "";
      if (auth) return !txt.includes("Send Login Code") && !!window.ME?.uid;
      return true;
    },
    expectAuth,
    { timeout: 60_000 },
  ).catch(() => {});
  await page.waitForTimeout(800);
}

/**
 * Navigate with a generous timeout.
 *
 * The Next dev server cold-compiles a route on first hit (measured ~18s), so the
 * default 30s goto is not enough for the first page of a run.
 */
const go = (page, path) =>
  page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 90_000 });

const txt = (page) => page.evaluate(() => document.body.innerText || "");

async function main() {
  const browser = await chromium.launch();

  // ==========================================================================
  // Anonymous: landing page interactions
  // ==========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await go(page, "/");
    await waitReady(page);

    // --- Navigation: a menu item must actually change the view ---
    // The nav renders <button>, not <a> — selectors anchored on href find nothing.
    const exploreBtn = page.locator('button:has-text("Explore")').first();
    if (await exploreBtn.count()) {
      await exploreBtn.click();
      // The route changes immediately, but the storefront compiles on first hit —
      // so wait for the URL, then give the new view time to render.
      await page
        .waitForURL(/\/explore/, { timeout: 30_000 })
        .catch(() => {});
      await page.waitForTimeout(4000);
      const t = await txt(page);
      // Assert on the DESTINATION being rendered, not on the landing headline
      // disappearing — the landing hero can linger while the view swaps.
      const onStorefront = /catalog|katalog|search|product/i.test(t) && t.length > 300;
      record(
        "landing: click Explore menu navigates to storefront",
        page.url().includes("/explore") && onStorefront,
        `${page.url().replace(BASE, "")} · ${t.length} chars`,
      );
    } else {
      record("landing: click Explore menu navigates to storefront", false, "Explore button not found");
    }

    // --- Language switch must change visible copy ---
    await go(page, "/");
    await waitReady(page);
    const idBtn = page.locator('button:has-text("ID")').first();
    if (await idBtn.count()) {
      await idBtn.click();
      await page.waitForTimeout(1200);
      const t = await txt(page);
      record(
        "landing: ID button switches language",
        /Masuk|Cari|Beli|Jelajahi/i.test(t),
        t.slice(0, 60).replace(/\s+/g, " "),
      );
    } else {
      record("landing: ID button switches language", false, "ID button not found");
    }

    // --- Sign-in form: the submit button must gate on a valid email ---
    // It renders `disabled` until the field has content — that is correct UX,
    // so assert the GATE (disabled → enabled), not "clicking does something".
    await go(page, "/auth");
    await waitReady(page);
    const sendBtn = page.locator('button:has-text("Send Login Code")').first();
    if (await sendBtn.count()) {
      const disabledEmpty = await sendBtn.isDisabled();
      const emailInput = page
        .locator('input[type="email"], input[name="email"], input[placeholder*="email" i]')
        .first();
      let disabledFilled = null;
      if (await emailInput.count()) {
        await emailInput.fill("rimuru@slimemarket.app");
        await page.waitForTimeout(800);
        disabledFilled = await sendBtn.isDisabled();
      }
      record(
        "auth: login button gated until email is filled",
        disabledEmpty === true && disabledFilled === false,
        `empty=${disabledEmpty ? "disabled" : "enabled"} · filled=${disabledFilled === null ? "n/a" : disabledFilled ? "disabled" : "enabled"}`,
      );
    } else {
      record("auth: login button gated until email is filled", false, "button not found");
    }

    await page.screenshot({ path: `${SHOT_DIR}/interact-anon.png`, fullPage: true }).catch(() => {});
    await ctx.close();
  }

  // ==========================================================================
  // Logged in as admin: dashboard interactions
  // ==========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = await ctx.request.post(`${BASE}/api/auth/dev-login`, {
      data: { email: "rimuru@slimemarket.app" },
    });
    record("login admin", login.ok(), `status ${login.status()}`);

    const page = await ctx.newPage();
    await go(page, "/admin");
    await waitReady(page, { expectAuth: true });

    const t0 = await txt(page);
    record("admin: dashboard opens (not sign-in)", !t0.includes("Send Login Code"));

    // --- Each admin tab must switch content ---
    for (const tab of ["Users", "Products", "Stores", "Sales", "Reports", "Disputes"]) {
      const el = page.locator(`button:has-text("${tab}"), [role="tab"]:has-text("${tab}")`).first();
      if (!(await el.count())) {
        record(`admin: tab ${tab}`, false, "tab not found");
        continue;
      }
      await el.click();
      await page.waitForTimeout(2500);
      const t = await txt(page);
      // A tab that never leaves "Loading..." is stuck.
      const stuck = /^\s*Loading\.\.\.\s*$/i.test(t) || t.includes("Loading...") && t.length < 80;
      record(`admin: tab ${tab} render`, !stuck, stuck ? "stuck at Loading..." : `${t.length} chars`);
    }

    // --- Sidebar navigation from the dashboard ---
    await go(page, "/admin");
    await waitReady(page, { expectAuth: true });
    // The sidebar renders <button>, and its items are Home / Explore / Escrow /
    // Discussion / Seller Center / Middleman / Admin Console — there is no
    // "Orders" entry, so navigate to one that actually exists.
    const escrowNav = page.locator('button:has-text("Escrow")').first();
    if (await escrowNav.count()) {
      await escrowNav.click();
      await page.waitForURL(/\/escrow/, { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const t = await txt(page);
      record(
        "nav: Admin → Escrow",
        page.url().includes("/escrow") && !t.includes("Send Login Code") && t.length > 200,
        `${page.url().replace(BASE, "")} · ${t.length} chars`,
      );
    } else {
      record("nav: Admin → Escrow", false, "Escrow button not found in sidebar");
    }

    await page.screenshot({ path: `${SHOT_DIR}/interact-admin.png`, fullPage: true }).catch(() => {});
    await ctx.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  writeFileSync(`${SHOT_DIR}/interact-report.json`, JSON.stringify(results, null, 2));
  console.log(
    failed.length
      ? `\n=== ${failed.length}/${results.length} INTERACTIONS FAILED: ${failed.map((f) => f.name).join(", ")} ===`
      : `\n=== ALL ${results.length} INTERACTIONS OK ===`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ui-interact failed:", e.message || e);
  process.exit(1);
});
