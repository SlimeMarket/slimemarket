import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { sendEmail } from "@/lib/notif/email";
import { formatUsdc } from "@/lib/money";
import { ARC_EXPLORER_TX_BASE } from "@/lib/arc";

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
  const statusColor =
    d.status === "DONE" || d.status === "RELEASED"
      ? "#059669"
      : d.status === "DISPUTED"
        ? "#dc2626"
        : d.status === "REFUNDED"
          ? "#6b7280"
          : "#0891b2";
  const statusBg =
    d.status === "DONE" || d.status === "RELEASED"
      ? "#ecfdf5"
      : d.status === "DISPUTED"
        ? "#fef2f2"
        : d.status === "REFUNDED"
          ? "#f3f4f6"
          : "#ecfeff";

  const txLine = d.txHash
    ? `<tr>
        <td style="padding:10px 0;color:#64748b;font-size:12px;border-bottom:1px solid #f1f5f9">Transaction</td>
        <td align="right" style="padding:10px 0;font-size:12px;border-bottom:1px solid #f1f5f9">
          <a href="${esc(d.explorerBase + d.txHash)}" style="color:#0891b2;text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace">${esc(d.txHash.slice(0, 24))}…</a>
        </td>
      </tr>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Invoice ${esc(d.invoiceNo)} — SlimeMarket</title>
  <style>
    @media print {
      body { background: #fff !important; }
      .invoice-wrap { box-shadow: none !important; border: 1px solid #e2e8f0; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1e293b;line-height:1.5">

<!-- Print button -->
<div class="no-print" style="text-align:center;padding:20px 12px">
  <button onclick="window.print()" style="background:#0f172a;color:#fff;border:none;padding:10px 24px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer">
    Print / Save as PDF
  </button>
</div>

<div class="invoice-wrap" style="max-width:680px;margin:0 auto 40px;background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 10px 40px rgba(0,0,0,.04);overflow:hidden">

  <!-- Header -->
  <div style="background:#0f172a;padding:36px 40px 32px;position:relative">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px">
      <div>
        <div style="font-size:26px;font-weight:800;color:#fff;letter-spacing:-0.5px">SlimeMarket</div>
        <div style="color:#94a3b8;font-size:13px;margin-top:4px">On-chain escrow marketplace</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#64748b;margin-bottom:4px">Invoice</div>
        <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.3px">${esc(d.invoiceNo)}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:2px">${esc(d.issuedAt)}</div>
      </div>
    </div>

    <!-- Status badge -->
    <div style="margin-top:20px">
      <span style="display:inline-block;padding:5px 14px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;background:${statusBg};color:${statusColor}">
        ${esc(d.status)}
      </span>
      <span style="display:inline-block;margin-left:8px;padding:5px 14px;border-radius:999px;font-size:11px;font-weight:600;background:#1e293b;color:#94a3b8">
        ${esc(d.networkLabel)}
      </span>
    </div>
  </div>

  <!-- Parties -->
  <div style="padding:28px 40px;background:#fafbfc;border-bottom:1px solid #f1f5f9">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:24px">
      <div style="min-width:220px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:8px">Buyer</div>
        <div style="font-size:14px;font-weight:600;color:#0f172a">${esc(d.buyerEmail ?? "—")}</div>
      </div>
      <div style="min-width:220px;text-align:right">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:8px">Seller</div>
        <div style="font-size:14px;font-weight:600;color:#0f172a">${esc(d.storeName)}</div>
      </div>
    </div>
  </div>

  <!-- Line Items -->
  <div style="padding:32px 40px">
    <table width="100%" style="border-collapse:collapse;font-size:14px">
      <thead>
        <tr>
          <th align="left" style="padding:10px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;border-bottom:2px solid #e2e8f0">Item</th>
          <th align="center" style="padding:10px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;border-bottom:2px solid #e2e8f0;width:80px">Qty</th>
          <th align="right" style="padding:10px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;border-bottom:2px solid #e2e8f0;width:140px">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:16px 0;border-bottom:1px solid #f1f5f9;vertical-align:top">
            <div style="font-weight:600;color:#0f172a">${esc(d.itemName)}</div>
            ${d.itemVariant ? `<div style="font-size:12px;color:#64748b;margin-top:2px">Variant: ${esc(d.itemVariant)}</div>` : ""}
          </td>
          <td align="center" style="padding:16px 0;border-bottom:1px solid #f1f5f9;color:#475569;vertical-align:top">${esc(String(d.qty))}</td>
          <td align="right" style="padding:16px 0;border-bottom:1px solid #f1f5f9;color:#0f172a;font-weight:600;vertical-align:top;font-variant-numeric:tabular-nums">${formatUsdc(d.subtotalMicro)} USDC</td>
        </tr>
      </tbody>
    </table>

    <!-- Totals -->
    <div style="margin-top:8px;margin-left:auto;max-width:320px">
      <table width="100%" style="border-collapse:collapse;font-size:14px">
        <tr>
          <td style="padding:10px 0;color:#64748b">Subtotal</td>
          <td align="right" style="padding:10px 0;color:#0f172a;font-weight:500;font-variant-numeric:tabular-nums">${formatUsdc(d.subtotalMicro)} USDC</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#64748b">Service fee <span style="font-size:11px;color:#94a3b8">(2%)</span></td>
          <td align="right" style="padding:10px 0;color:#0f172a;font-weight:500;font-variant-numeric:tabular-nums">${formatUsdc(d.buyerFeeMicro)} USDC</td>
        </tr>
        <tr>
          <td colspan="2" style="border-top:2px solid #e2e8f0"></td>
        </tr>
        <tr>
          <td style="padding:14px 0;font-size:16px;font-weight:800;color:#0f172a">Total Paid</td>
          <td align="right" style="padding:14px 0;font-size:18px;font-weight:800;color:#0f172a;font-variant-numeric:tabular-nums">${formatUsdc(d.totalMicro)} USDC</td>
        </tr>
      </table>
    </div>
  </div>

  <!-- Payment Info -->
  <div style="padding:24px 40px;background:#f8fafc;border-top:1px solid #f1f5f9">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:12px">Payment Details</div>
    <table width="100%" style="border-collapse:collapse;font-size:12px">
      <tr>
        <td style="padding:10px 0;color:#64748b;font-size:12px;border-bottom:1px solid #f1f5f9;width:160px">Method</td>
        <td style="padding:10px 0;color:#0f172a;font-weight:600;font-size:12px;border-bottom:1px solid #f1f5f9">${esc(d.paymentMethod)}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;color:#64748b;font-size:12px;border-bottom:1px solid #f1f5f9">Order ID</td>
        <td style="padding:10px 0;color:#0f172a;font-size:12px;border-bottom:1px solid #f1f5f9;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace">${esc(d.orderId)}</td>
      </tr>
      ${d.onChainOrderId ? `<tr>
        <td style="padding:10px 0;color:#64748b;font-size:12px;border-bottom:1px solid #f1f5f9">On-chain Order</td>
        <td style="padding:10px 0;color:#0f172a;font-size:12px;border-bottom:1px solid #f1f5f9;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace">${esc(d.onChainOrderId)}</td>
      </tr>` : ""}
      ${txLine}
      <tr>
        <td style="padding:10px 0;color:#64748b;font-size:12px;vertical-align:top">Escrow Contract</td>
        <td style="padding:10px 0;color:#0f172a;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;word-break:break-all">${esc(d.escrowAddress)}</td>
      </tr>
    </table>
  </div>

  <!-- Footer -->
  <div style="padding:24px 40px;background:#0f172a">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div>
        <div style="font-size:13px;font-weight:700;color:#fff">SlimeMarket</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">Trustless escrow · ${esc(d.networkLabel)}</div>
      </div>
      <div style="text-align:right">
        <a href="${esc(d.appUrl)}" style="color:#0891b2;font-size:12px;text-decoration:none">${esc(d.appUrl)}</a>
        <div style="font-size:11px;color:#475569;margin-top:4px">Service fee non-refundable · Funds held in escrow until delivery confirmed</div>
      </div>
    </div>
  </div>

</div>

</body>
</html>`;
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
      explorerBase: ARC_EXPLORER_TX_BASE,
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
