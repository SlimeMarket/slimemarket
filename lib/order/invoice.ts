import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { sendEmail } from "@/lib/notif/email";
import { formatUsdc } from "@/lib/money";

/**
 * Order invoice — sent to the buyer the moment their payment lands in escrow.
 *
 * WHY: an escrow marketplace asks a stranger to send real USDC to a contract.
 * The buyer's only durable proof of what they bought, what they paid and which
 * on-chain transaction carried it is the record we email them. Without it the
 * order exists only inside our database, which is exactly the thing a buyer has
 * no reason to trust yet.
 *
 * THE TOTALS MIRROR THE APP'S OWN UI, deliberately. `public/orders.jsx` shows
 *
 *     const total = (order.amount || 0) + (order.adminFee || 0)
 *
 * so "Total Paid" here is `amount + buyer_fee`. `circle_fee` and `gas_fee` are
 * platform-side costs and are NOT charged to the buyer, so they are not added.
 * An invoice that disagrees with the checkout screen is worse than no invoice.
 *
 * All money columns are bigint MICRO-USDC (6 decimals) and are rendered through
 * `formatUsdc`.
 *
 * SECURITY: every interpolated value is HTML-escaped. Product names, variants and
 * store names are seller-controlled, so an unescaped invoice is a stored-XSS /
 * phishing vector delivered straight to the buyer's inbox under our branding.
 */

export interface InvoiceData {
  invoiceNo: string;
  issuedAt: string;
  orderId: string;
  buyerEmail: string | null;
  storeName: string;
  itemName: string;
  itemVariant: string | null;
  qty: number;
  subtotalMicro: bigint;
  buyerFeeMicro: bigint;
  totalMicro: bigint;
  paymentMethod: string;
  status: string;
  onChainOrderId: string | null;
  txHash: string | null;
  escrowAddress: string;
  explorerBase: string;
  appUrl: string;
  networkLabel: string;
}

/** Coerce a PostgREST value (number | string | bigint | null) to bigint micro. */
export function micro(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.round(v));
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) return BigInt(s);
  const n = Number(s);
  return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n;
}

/** `SM-3F9A2C1B` — stable, human-quotable, derived from the order id. */
export function invoiceNumber(orderId: string): string {
  return `SM-${orderId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderInvoiceText(d: InvoiceData): string {
  const lines = [
    `SlimeMarket — Invoice ${d.invoiceNo}`,
    `Issued: ${d.issuedAt}`,
    `Buyer:  ${d.buyerEmail ?? "—"}`,
    `Seller: ${d.storeName}`,
    "",
    `Item: ${d.itemName}${d.itemVariant ? ` (${d.itemVariant})` : ""}  x${d.qty}`,
    "",
    `Subtotal (${d.qty} item)   ${formatUsdc(d.subtotalMicro)} USDC`,
    `Service fee (2%)      ${formatUsdc(d.buyerFeeMicro)} USDC`,
    `--------------------------------------`,
    `TOTAL PAID            ${formatUsdc(d.totalMicro)} USDC`,
    "",
    `Payment method: ${d.paymentMethod}`,
    `Status: ${d.status} — held in escrow until you confirm delivery`,
    `Order: ${d.orderId}`,
  ];
  if (d.onChainOrderId) lines.push(`On-chain order id: ${d.onChainOrderId}`);
  if (d.txHash) lines.push(`Transaction: ${d.explorerBase}${d.txHash}`);
  lines.push(
    "",
    `Escrow contract: ${d.escrowAddress} (${d.networkLabel})`,
    `Your order: ${d.appUrl}/#orders`,
    "",
    "The 2% service fee is non-refundable. The item amount is released to the",
    "seller only after you confirm delivery, or automatically after the release",
    "window if you do not raise a dispute.",
    "",
    "SlimeMarket",
  );
  return lines.join("\n");
}

export function renderInvoiceHtml(d: InvoiceData): string {
  const row = (label: string, value: string, strong = false) =>
    `<tr>` +
    `<td style="padding:6px 0;color:${strong ? "#0f172a" : "#475569"};${
      strong ? "font-weight:600;" : ""
    }">${esc(label)}</td>` +
    `<td align="right" style="padding:6px 0;color:#0f172a;${
      strong ? "font-weight:700;font-size:16px;" : ""
    }">${esc(value)}</td>` +
    `</tr>`;

  const txLine = d.txHash
    ? `<p style="margin:4px 0;font-size:13px;color:#475569">Transaction:
         <a href="${esc(d.explorerBase + d.txHash)}" style="color:#0891b2">${esc(
           d.txHash.slice(0, 18),
         )}…</a></p>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;background:#f1f5f9;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="background:#0f172a;padding:20px 24px">
    <div style="color:#ffffff;font-size:18px;font-weight:700">SlimeMarket</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:2px">On-chain escrow marketplace · ${esc(
      d.networkLabel,
    )}</div>
  </td></tr>
  <tr><td style="padding:24px">
    <div style="font-size:20px;font-weight:700;color:#0f172a">Invoice ${esc(d.invoiceNo)}</div>
    <p style="margin:6px 0 18px;font-size:13px;color:#64748b">Issued ${esc(d.issuedAt)}</p>

    <table role="presentation" width="100%" style="font-size:13px;border-collapse:collapse">
      ${row("Buyer", d.buyerEmail ?? "—")}
      ${row("Seller", d.storeName)}
      ${row("Item", `${d.itemName}${d.itemVariant ? ` (${d.itemVariant})` : ""}`)}
      ${row("Quantity", String(d.qty))}
      ${row("Payment method", d.paymentMethod)}
    </table>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:18px 0">

    <table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse">
      ${row(`Subtotal (${d.qty} item)`, `${formatUsdc(d.subtotalMicro)} USDC`)}
      ${row("Service fee (2%)", `${formatUsdc(d.buyerFeeMicro)} USDC`)}
      ${row("TOTAL PAID", `${formatUsdc(d.totalMicro)} USDC`, true)}
    </table>

    <div style="margin-top:18px;padding:12px 14px;background:#ecfdf5;border-radius:10px;font-size:13px;color:#065f46">
      <strong>${esc(d.status)}</strong> — your payment is held in escrow and is released to the
      seller only after you confirm delivery.
    </div>

    <div style="margin-top:18px;font-size:12px;color:#64748b;word-break:break-all">
      <p style="margin:4px 0">Order: <span style="font-family:ui-monospace,monospace">${esc(
        d.orderId,
      )}</span></p>
      ${d.onChainOrderId ? `<p style="margin:4px 0">On-chain order id: <span style="font-family:ui-monospace,monospace">${esc(d.onChainOrderId)}</span></p>` : ""}
      ${txLine}
      <p style="margin:4px 0">Escrow contract: <span style="font-family:ui-monospace,monospace">${esc(
        d.escrowAddress,
      )}</span></p>
      <p style="margin:12px 0 0">The 2% service fee is non-refundable.</p>
    </div>
  </td></tr>
  <tr><td style="padding:16px 24px;background:#f8fafc;font-size:12px;color:#94a3b8">
    <a href="${esc(d.appUrl)}" style="color:#0891b2">${esc(d.appUrl)}</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** Build the invoice view-model from raw rows (pure — the unit under test). */
export function buildInvoiceData(args: {
  order: Record<string, unknown>;
  productName: string | null;
  storeName: string | null;
  buyerEmail: string | null;
  escrowAddress: string;
  explorerBase: string;
  appUrl: string;
  networkLabel: string;
}): InvoiceData {
  const o = args.order;
  const subtotalMicro = micro(o.amount);
  const buyerFeeMicro = micro(o.buyer_fee);
  return {
    invoiceNo: invoiceNumber(String(o.id ?? "")),
    issuedAt: o.created_at
      ? new Date(String(o.created_at)).toISOString().replace("T", " ").slice(0, 16) + " UTC"
      : "—",
    orderId: String(o.id ?? ""),
    buyerEmail: args.buyerEmail,
    storeName: args.storeName ?? "—",
    itemName: args.productName ?? "Order item",
    itemVariant: o.variant ? String(o.variant) : null,
    qty: Number(o.qty ?? 1),
    subtotalMicro,
    buyerFeeMicro,
    totalMicro: subtotalMicro + buyerFeeMicro,
    paymentMethod: String(o.payment ?? "—"),
    status: String(o.status ?? "—"),
    onChainOrderId: o.on_chain_order_id ? String(o.on_chain_order_id) : null,
    txHash: o.on_chain_tx_hash ? String(o.on_chain_tx_hash) : null,
    escrowAddress: args.escrowAddress,
    explorerBase: args.explorerBase,
    appUrl: args.appUrl,
    networkLabel: args.networkLabel,
  };
}

/**
 * Load the order, render the invoice and email it to the buyer.
 * Best-effort: never throws, never blocks a payment flow.
 */
export async function sendOrderInvoice(
  orderId: string,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const admin = supabaseAdminClient();

    const { data: order } = await admin
      .from("orders")
      .select(
        "id, buyer_id, store_id, product_id, variant, qty, amount, buyer_fee, payment, status, created_at, on_chain_order_id, on_chain_tx_hash",
      )
      .eq("id", orderId)
      .maybeSingle();
    if (!order) return { sent: false, reason: "order not found" };

    const [{ data: product }, { data: store }, { data: buyer }] = await Promise.all([
      order.product_id
        ? admin.from("products").select("name").eq("id", order.product_id).maybeSingle()
        : Promise.resolve({ data: null }),
      order.store_id
        ? admin.from("stores").select("name").eq("id", order.store_id).maybeSingle()
        : Promise.resolve({ data: null }),
      order.buyer_id
        ? admin.from("users").select("email").eq("id", order.buyer_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const email = (buyer?.email as string | undefined) ?? null;
    if (!email) return { sent: false, reason: "buyer has no email" };

    const data = buildInvoiceData({
      order,
      productName: (product?.name as string | undefined) ?? null,
      storeName: (store?.name as string | undefined) ?? null,
      buyerEmail: email,
      escrowAddress: process.env.ESCROW_CONTRACT_ADDRESS ?? "",
      explorerBase: process.env.ARC_EXPLORER_URL || "https://testnet.arcscan.app/tx/",
      appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://slimemarket.app",
      networkLabel:
        (process.env.ARC_CHAIN_ID ?? "") === "5042" ? "Arc Mainnet" : "Arc Testnet",
    });

    return await sendEmail({
      to: email,
      subject: `Invoice ${data.invoiceNo} — ${data.itemName}`,
      text: renderInvoiceText(data),
      html: renderInvoiceHtml(data),
    });
  } catch (e) {
    console.error("sendOrderInvoice failed:", e instanceof Error ? e.message : String(e));
    return { sent: false, reason: "invoice error" };
  }
}
