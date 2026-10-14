/**
 * End-to-end buy flow through the real UI. Works in BOTH payment modes:
 *
 *   ONCHAIN_WALLET_FUNDS=1  → gate on on-chain USDC, order via /api/orders/checkout/prepare
 *   ONCHAIN_WALLET_FUNDS=0  → gate on the ledger balance, order via /api/orders
 *
 * Picks the cheapest product the buyer can actually afford, so the run does not
 * depend on how the storefront happens to be sorted.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.request.post(`${BASE}/api/auth/dev-login`, { data: { email: "rimuru@slimemarket.app" } });
const p = await ctx.newPage();

const calls = [];
p.on("response", async (r) => {
  const u = r.url();
  if (u.includes("/api/orders") && r.request().method() === "POST") {
    let body = "";
    try { body = (await r.text()).slice(0, 200); } catch {}
    calls.push({ status: r.status(), path: u.replace(BASE, ""), body });
  }
});

const step = (n, ok, d = "") => console.log(`${ok ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`);

// 0. wallet balance must be hydrated before the gate is meaningful.
await p.goto(`${BASE}/explore`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await p
  .waitForFunction(() => (window.ME?.usdc ?? 0) > 0 || (window.ME?.usdcOnChain ?? 0) > 0, { timeout: 60_000 })
  .catch(() => {});
await p.locator('button:has-text("Buy")').first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});

const bal = await p.evaluate(() => ({
  ledger: window.ME?.usdc ?? 0,
  chain: window.ME?.usdcOnChain ?? 0,
  onchain: !!window.ONCHAIN_FUNDS,
}));
const gate = bal.onchain ? bal.chain : bal.ledger;
step("0. buyer balance loaded", gate > 0,
  `mode=${bal.onchain ? "on-chain" : "ledger"} gate=${gate} (ledger=${bal.ledger} chain=${bal.chain})`);

// 1. pick the cheapest affordable product card.
//    Each Buy button sits inside a card whose nearest ancestor (≈2 levels up)
//    carries the price as "FROM <n> USDC" — the lowest variant price.
const picked = await p.evaluate((budget) => {
  const cards = [...document.querySelectorAll("button")]
    .filter((el) => /^Buy$/i.test((el.innerText || "").trim()))
    .map((el, i) => {
      let n = el, hops = 0, price = Infinity, title = "";
      while (n && hops < 4) {
        const t = (n.innerText || "").replace(/\s+/g, " ").trim();
        const m = t.match(/([\d.]+)\s*USDC/);
        if (m && t.length > 25) { price = parseFloat(m[1]); title = t.slice(0, 60); break; }
        n = n.parentElement; hops++;
      }
      return { i, price, title };
    })
    .sort((a, z) => a.price - z.price);
  const affordable = cards.filter((c) => c.price * 1.02 <= budget);
  return { total: cards.length, pick: affordable[0] ?? cards[0] ?? null, affordable: affordable.length };
}, gate);
step("1. storefront shows products", picked.total > 0,
  `${picked.total} cards, ${picked.affordable} affordable (<= ${gate})`);
step("2. an affordable product exists", !!picked.pick && picked.pick.price * 1.02 <= gate,
  picked.pick ? `${picked.pick.title} @ ${picked.pick.price} USDC` : "-");
if (!picked.pick) { await b.close(); process.exit(1); }

// Click the Buy belonging to the chosen (cheapest) card.
await p.evaluate((idx) => {
  const btns = [...document.querySelectorAll("button")].filter((el) => /^Buy$/i.test((el.innerText || "").trim()));
  btns[idx]?.click();
}, picked.pick.i);

await p.waitForFunction(() => /PAYMENT METHOD/i.test(document.body.innerText || ""), { timeout: 30_000 }).catch(() => {});
const modal = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
step("3. checkout modal open", /PAYMENT METHOD/i.test(modal));

const subtotal = (modal.match(/Subtotal[^0-9]*([\d.]+)USDC/i) || [])[1];
const fee = (modal.match(/Admin Fee[^0-9]*([\d.]+)USDC/i) || [])[1];
const total = (modal.match(/Total\s+([\d.]+)USDC/i) || [])[1];
step("4. 2% fee computed correctly", !!(subtotal && fee && total) && Math.abs(+subtotal * 0.02 - +fee) < 0.005,
  `${subtotal} + ${fee} = ${total}`);

await p.locator('button:has-text("Slime Wallet")').first().click({ timeout: 15_000 }).catch(() => {});
await p.waitForTimeout(2500);
const after = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const gateShown = (after.match(/On-chain Balance \(Arc\)\s+([\d.]+)USDC/i) || [])[1];
step("5. balance gate sufficient", !/Insufficient Balance/i.test(after),
  `balance read ${gateShown ?? "-"} USDC, total ${total}`);

const pay = p.locator('button:has-text("Pay via Wallet")').first();
const canPay = await pay.count();
step("6. pay button enabled", canPay > 0);
if (canPay) {
  await pay.click({ timeout: 15_000 }).catch(() => {});
  await p.waitForTimeout(12_000);
}

const ok = calls.some((c) => c.status === 201);
step("7. order created", ok, calls.map((c) => `${c.status} ${c.path}`).join(" | ") || "(no request)");
calls.forEach((c) => console.log("     body:", c.body));

await p.screenshot({ path: ".secrets/_ui-shots/buy-flow.png", fullPage: true }).catch(() => {});
await b.close();
