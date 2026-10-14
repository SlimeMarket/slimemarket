/**
 * New order notification — sent to the SELLER when a buyer places an order.
 */
import { baseHtml, ctaButton, esc, summaryRow, EmailTemplateResult } from "./base";

export interface OrderNewData {
  orderId: string;
  itemName: string;
  itemVariant?: string | null;
  qty: number;
  amountUsdc: string;
  buyerName: string;
  paymentMethod: string;
  status: string;
  appUrl?: string;
}

export function orderNewTemplate(d: OrderNewData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const orderShort = d.orderId.slice(0, 8);
  const subject = `New Order #${orderShort} — ${d.amountUsdc} USDC`;

  const text = `You have a new order!

Order #${orderShort}
Item: ${d.itemName}${d.itemVariant ? ` (${d.itemVariant})` : ""} x${d.qty}
Amount: ${d.amountUsdc} USDC
Buyer: ${d.buyerName}
Payment: ${d.paymentMethod}
Status: ${d.status}

The buyer's payment is now held in escrow. Prepare the item and mark it as delivered when ready.

View order: ${appUrl}/seller

— SlimeMarket`;

  const body = `<div style="font-size:20px;font-weight:700;color:#0f172a;margin-bottom:8px">New Order Received</div>
<p style="margin:0 0 18px;color:#64748b;font-size:13px">Order #<span style="font-family:ui-monospace,monospace">${esc(orderShort)}</span></p>

<table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px;margin-bottom:18px">
  ${summaryRow("Item", `${d.itemName}${d.itemVariant ? ` (${d.itemVariant})` : ""} × ${d.qty}`)}
  ${summaryRow("Amount", `${d.amountUsdc} USDC`, true)}
  ${summaryRow("Buyer", d.buyerName)}
  ${summaryRow("Payment", d.paymentMethod)}
  ${summaryRow("Status", d.status)}
</table>

<div style="margin:16px 0;padding:12px 14px;background:#ecfdf5;border-radius:10px;font-size:13px;color:#065f46">
  <strong>Payment secured in escrow.</strong> Prepare the item and mark it as delivered when ready.
</div>

${ctaButton("View in Dashboard", `${appUrl}/seller`)}

<p style="margin:12px 0 0;color:#64748b;font-size:12px">The buyer's funds are held by the escrow contract until delivery is confirmed.</p>`;

  const html = baseHtml({
    title: subject,
    previewText: `New order for ${d.amountUsdc} USDC from ${d.buyerName}. Payment secured in escrow.`,
    bodyContent: body,
    appUrl,
    footerLinks: [
      { label: "Seller Dashboard", url: `${appUrl}/seller` },
      { label: "Help Center", url: `${appUrl}/help` },
    ],
  });

  return { subject, text, html };
}
