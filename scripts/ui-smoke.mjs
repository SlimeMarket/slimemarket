/**
 * UI smoke test — drive the real app in a browser and report what breaks.
 *
 * The API sweep proves handlers respond; it says nothing about whether the UI
 * renders. A React page can throw during render, log a console error, or fire a
 * request that 500s — all while the route returns a perfectly healthy HTML shell.
 * So this loads each page for real and collects:
 *
 *   - uncaught exceptions (pageerror)  → the page is broken
 *   - console errors                   → React warnings, failed fetches
 *   - failed network requests (>=400)  → the page asked for something broken
 *   - screenshots                      → visual evidence to review
 *
 * Usage: node scripts/ui-smoke.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SHOT_DIR = ".secrets/_ui-shots";
mkdirSync(SHOT_DIR, { recursive: true });

/** Pages to visit. `auth` means "log in first"; public ones run logged out too. */
const PAGES = [
  { path: "/", name: "home", auth: false },
  { path: "/explore", name: "storefront", auth: false },
  { path: "/products", name: "products", auth: false },
  { path: "/forum", name: "forum", auth: false },
  { path: "/auth", name: "auth", auth: false },
  { path: "/wallet", name: "wallet", auth: true },
  { path: "/orders", name: "orders", auth: true },
  { path: "/escrow", name: "escrow", auth: true },
  { path: "/chat", name: "chat", auth: true },
  { path: "/seller", name: "seller", auth: true },
  { path: "/admin", name: "admin", auth: true },
  { path: "/mm", name: "mm", auth: true },
  { path: "/profile", name: "profile", auth: true },
];

const findings = [];

async function login(context, email) {
  const res = await context.request.post(`${BASE}/api/auth/dev-login`, {
    data: { email },
  });
  return res.ok();
}

async function visit(context, page, label) {
  const errors = [];
  const failed = [];

  const onPageError = (e) => errors.push(`uncaught: ${e.message}`);
  const onConsole = (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // React's dev-mode noise and favicon 404s are not product bugs.
    if (/favicon|Download the React DevTools|ReactDOM.render/i.test(t)) return;
    // The browser logs every 401 as a console error. For an anonymous visitor
    // the session probe is SUPPOSED to 401 — see onResponse above.
    if (label === "anon" && /401/.test(t) && /Unauthorized/i.test(t)) return;
    errors.push(`console: ${t.slice(0, 200)}`);
  };
  const onResponse = (r) => {
    const u = r.url();
    if (!u.startsWith(BASE)) return;
    if (r.status() < 400) return;
    // `/api/auth/me` is the session probe. A 401 is the CORRECT answer for a
    // logged-out visitor — flagging it would make every public page look broken.
    // In the logged-in pass the same 401 is a real failure (the session should
    // exist), so it is only excused when we are deliberately anonymous.
    if (label === "anon" && r.status() === 401 && u.includes("/api/auth/me")) return;
    failed.push(`${r.status()} ${u.replace(BASE, "")}`);
  };

  const p = await context.newPage();
  p.on("pageerror", onPageError);
  p.on("console", onConsole);
  p.on("response", onResponse);

  let navError = null;
  // NOT `networkidle`. The landing page pulls a Coinbase attribution script
  // (cca-lite.coinbase.com) that never settles, so `networkidle` times out even
  // though the page rendered perfectly.
  //
  // Retry once: the dev server compiles each route on FIRST hit, and a cold
  // compile can exceed the timeout while the route itself is perfectly healthy
  // (~90ms on the second request). Without the retry this shows up as a random
  // page failing each run, which trains you to ignore the report.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await p.goto(BASE + page.path, { waitUntil: "domcontentloaded", timeout: 30_000 });
      navError = null;
      break;
    } catch (e) {
      navError = e.message.split("\n")[0];
      if (attempt === 1) await p.waitForTimeout(1000);
    }
  }

  // Wait for the app to be READY, not merely to have painted something.
  //
  // `root.length > 500` is NOT a readiness signal: the sign-in shell satisfies
  // it immediately. The app compiles JSX with in-browser Babel and only then
  // restores the session, so an early screenshot captures the sign-in screen and
  // the page gets marked healthy while showing the WRONG page — which is exactly
  // what happened to /wallet (first page of the logged-in pass).
  //
  // Ready means: ME is populated (logged-in pass), or the app has settled into a
  // non-sign-in view (anonymous pass).
  let rootHtml = -1;
  try {
    await p.waitForFunction(
      (expectAuth) => {
        const root = document.getElementById("root");
        if (!root || root.innerHTML.length < 500) return false;
        const txt = document.body.innerText || "";
        if (expectAuth) return !txt.includes("Send Login Code") && !!window.ME?.uid;
        return true;
      },
      page.auth,
      { timeout: 45_000 },
    );
  } catch {
    // fall through — the evaluation below reports whatever we actually got
  }
  await p.waitForTimeout(1200);

  const bodyText = await p.evaluate(() => document.body.innerText || "").catch(() => "");
  rootHtml = await p.evaluate(() => {
    const r = document.getElementById("root");
    return r ? r.innerHTML.length : -1;
  }).catch(() => -1);

  // A logged-in page still showing the sign-in form means the session was not
  // restored. "Renders fine" checks cannot see this — the shell looks healthy.
  const wrongPage = page.auth && bodyText.includes("Send Login Code");

  const shot = `${SHOT_DIR}/${label}-${page.name}.png`;
  await p.screenshot({ path: shot, fullPage: true }).catch(() => {});
  await p.close();

  // A page that renders nothing is the loudest possible failure.
  const blank = rootHtml === 0 || bodyText.trim().length < 20;

  findings.push({
    name: page.name,
    path: page.path,
    label,
    navError,
    blank,
    wrongPage,
    rootLen: rootHtml,
    errors: [...new Set(errors)],
    failed: [...new Set(failed)],
    shot,
  });
}

async function main() {
  const browser = await chromium.launch();
  const problems = [];

  // ---- Pass 1: logged out ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    for (const page of PAGES.filter((p) => !p.auth)) {
      await visit(ctx, page, "anon");
    }
    await ctx.close();
  }

  // ---- Pass 2: logged in as admin ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ok = await login(ctx, "rimuru@slimemarket.app");
    console.log(`login admin: ${ok ? "OK" : "FAILED"}`);
    for (const page of PAGES.filter((p) => p.auth)) {
      await visit(ctx, page, "admin");
    }
    await ctx.close();
  }

  await browser.close();

  console.log("\n=== UI SMOKE TEST RESULTS ===\n");
  for (const f of findings) {
    const bad = f.navError || f.blank || f.wrongPage || f.errors.length || f.failed.length;
    const icon = bad ? "❌" : "✅";
    console.log(`${icon} ${f.name.padEnd(12)} ${f.path}`);
    if (f.navError) console.log(`     navigation failed: ${f.navError}`);
    if (f.blank) console.log(`     BLANK PAGE (root=${f.rootLen} chars)`);
    if (f.wrongPage) console.log(`     WRONG PAGE — still showing sign-in despite an active session`);
    for (const e of f.errors.slice(0, 4)) console.log(`     ${e}`);
    for (const r of f.failed.slice(0, 4)) console.log(`     req: ${r}`);
    if (bad) problems.push(f.name);
  }

  writeFileSync(`${SHOT_DIR}/report.json`, JSON.stringify(findings, null, 2));
  console.log(`\nScreenshot: ${SHOT_DIR}/`);
  console.log(
    problems.length
      ? `\n=== ${problems.length} PAGES WITH PROBLEMS: ${problems.join(", ")} ===`
      : "\n=== ALL PAGES CLEAN ===",
  );
  if (problems.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ui-smoke failed:", e.message || e);
  process.exit(1);
});
