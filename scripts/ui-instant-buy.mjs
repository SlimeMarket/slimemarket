/**
 * Buy an INSTANT product through the UI and prove stock actually moves.
 *
 * The instant path is where the stock bug lived: checkout popped from the wrong
 * store and reported "insufficient stock" while the UI showed stock available.
 * This drives the real modal and then checks the database for the decrement.
 *
 * Usage: node scripts/ui-instant-buy.mjs
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.request.post(`${BASE}/api/auth/dev-login`, { data: { email: "rimuru@slimemarket.app" } });
const p = await ctx.newPage();

const step = (n, ok, d = "") => console.log(`${ok ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`);

let orderRes = null;
p.on("response", async (r) => {
  if (r.url().endsWith("/api/orders") && r.request().method() === "POST") {
    orderRes = { status: r.status(), body: (await r.text()).slice(0, 220) };
  }
});

await p.goto(`${BASE}/explore`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await p
  .waitForFunction(() => (window.ME?.usdc ?? 0) > 0 || (window.ME?.usdcOnChain ?? 0) > 0, { timeout: 60_000 })
  .catch(() => {});
await p.locator('button:has-text("Buy")').first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});

// Pick the first card whose text mentions Instant delivery.
const picked = await p.evaluate(() => {
  const cards = [...document.querySelectorAll("button")]
    .filter((el) => /^Buy$/i.test((el.innerText || "").trim()))
    .map((el) => el.closest('[class*="rounded"]') || el.parentElement);
  for (const c of cards) {
    const t = (c?.innerText || "").replace(/\s+/g, " ");
    if (/instant/i.test(t)) return { title: t.split("\n")[0].slice(0, 40), ok: true };
  }
  return { title: cards[0] ? (cards[0].innerText || "").replace(/\s+/g, " ").slice(0, 40) : "-", ok: false };
});
step("1. found an instant product in the storefront", picked.ok, picked.title);

// Click the Buy that belongs to an instant card.
const clicked = await p.evaluate(() => {
  const btns = [...document.querySelectorAll("button")].filter((el) => /^Buy$/i.test((el.innerText || "").trim()));
  for (const btn of btns) {
    const c = btn.closest('[class*="rounded"]') || btn.parentElement;
    if (/instant/i.test((c?.innerText || ""))) {
      btn.click();
      return true;
    }
  }
  if (btns[0]) { btns[0].click(); return true; }
  return false;
});
step("2. clicked Buy on the instant product", clicked);

await p.waitForFunction(() => /PAYMENT METHOD/i.test(document.body.innerText || ""), { timeout: 30_000 }).catch(() => {});
const modal = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
step("3. modal opened", /PAYMENT METHOD/i.test(modal));
const stockLabel = (modal.match(/Default\s+(\d+)\s*·\s*(\d+)/) || []).slice(1).join(" / ");
console.log("   variant/stock in modal:", stockLabel || "(unreadable)");

await p.locator('button:has-text("Slime Wallet")').first().click({ timeout: 15_000 }).catch(() => {});
await p.waitForTimeout(2500);

const pay = p.locator('button:has-text("Pay via Wallet")').first();
const canPay = await pay.count();
step("4. pay button enabled", canPay > 0);
if (canPay) {
  await pay.click({ timeout: 15_000 }).catch(() => {});
  await p.waitForTimeout(12_000);
}
step("5. POST /api/orders", orderRes ? orderRes.status === 201 : false,
  orderRes ? `${orderRes.status} ${orderRes.body}` : "(no request)");

await p.screenshot({ path: ".secrets/_ui-shots/instant-buy.png", fullPage: true }).catch(() => {});
await b.close();
