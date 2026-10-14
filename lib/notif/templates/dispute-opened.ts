/**
 * Dispute opened — sent to BOTH parties.
 */
import { baseHtml, ctaButton, esc, summaryRow, EmailTemplateResult } from "./base";

export interface DisputeOpenedData {
  orderId: string;
  itemName: string;
  amountUsdc: string;
  openedBy: "buyer" | "seller";
  openerName: string;
  reason: string;
  appUrl?: string;
}

export function disputeOpenedTemplate(d: DisputeOpenedData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const orderShort = d.orderId.slice(0, 8);
  const subject = `Dispute Opened — Order #${orderShort}`;

  const text = `A dispute has been opened for your order.

Order #${orderShort}
Item: ${d.itemName}
Amount: ${d.amountUsdc} USDC
Opened by: ${d.openerName} (${d.openedBy})
Reason: ${d.reason}

The order funds are now frozen in escrow while the dispute is reviewed. A middleman will investigate and make a determination.

Please provide any evidence or context that supports your case through the dispute interface.

View dispute: ${appUrl}/orders

— SlimeMarket`;

  const body = `<div style="font-size:20px;font-weight:700;color:#0f172a;margin-bottom:8px">Dispute Opened</div>
<p style="margin:0 0 18px;color:#64748b;font-size:13px">Order #<span style="font-family:ui-monospace,monospace">${esc(orderShort)}</span></p>

<table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px;margin-bottom:18px">
  ${summaryRow("Item", d.itemName)}
  ${summaryRow("Amount", `${d.amountUsdc} USDC`)}
  ${summaryRow("Opened by", `${d.openerName} (${d.openedBy})`)}
</table>

<div style="margin:16px 0;padding:12px 14px;background:#fffbeb;border-radius:10px;font-size:13px;color:#92400e;border-left:4px solid #f59e0b">
  <strong>Funds frozen.</strong> The order amount is held in escrow while the dispute is under review. A middleman will investigate and make a determination.
</div>

<div style="margin:16px 0;padding:12px 14px;background:#f8fafc;border-radius:10px;font-size:13px;color:#334155">
  <strong>Reason stated:</strong> ${esc(d.reason)}
</div>

<p style="margin:16px 0;color:#334155;font-size:14px;line-height:1.6">
  Please provide any evidence or context that supports your case through the dispute interface.
</p>

${ctaButton("View Dispute", `${appUrl}/orders`)}

<p style="margin:12px 0 0;color:#64748b;font-size:12px">Decisions are based on contract state, evidence provided, and platform policy.</p>`;

  const html = baseHtml({
    title: subject,
    previewText: `Dispute opened for order #${orderShort}. Funds frozen in escrow pending review.`,
    bodyContent: body,
    appUrl,
    footerLinks: [
      { label: "My Orders", url: `${appUrl}/orders` },
      { label: "Support", url: `${appUrl}/help` },
    ],
  });

  return { subject, text, html };
}
