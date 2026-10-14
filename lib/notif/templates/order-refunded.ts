/**
 * Refund issued — sent to the BUYER.
 */
import { baseHtml, ctaButton, esc, summaryRow, EmailTemplateResult } from "./base";

export interface OrderRefundedData {
  orderId: string;
  itemName: string;
  refundAmountUsdc: string;
  feeNotRefundedUsdc: string;
  reason?: string;
  txHash?: string | null;
  explorerUrl?: string;
  appUrl?: string;
}

export function orderRefundedTemplate(d: OrderRefundedData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const orderShort = d.orderId.slice(0, 8);
  const subject = `Refund Issued — Order #${orderShort}`;

  const text = `Your order has been refunded.

Order #${orderShort}
Item: ${d.itemName}
Refund amount: ${d.refundAmountUsdc} USDC
Service fee (not refunded): ${d.feeNotRefundedUsdc} USDC
${d.reason ? `Reason: ${d.reason}` : ""}

The refund has been sent back to your wallet. It may take a few minutes to appear depending on network congestion.
${d.txHash && d.explorerUrl ? `Transaction: ${d.explorerUrl}${d.txHash}` : ""}

View orders: ${appUrl}/orders

— SlimeMarket`;

  const txLine = d.txHash && d.explorerUrl
    ? `<p style="margin:8px 0;font-size:12px;color:#475569">Transaction: <a href="${esc(d.explorerUrl + d.txHash)}" style="color:#0891b2;font-family:ui-monospace,monospace">${esc(d.txHash.slice(0, 18))}…</a></p>`
    : "";

  const reasonLine = d.reason
    ? `<p style="margin:8px 0;font-size:13px;color:#475569"><strong>Reason:</strong> ${esc(d.reason)}</p>`
    : "";

  const body = `<div style="font-size:20px;font-weight:700;color:#0f172a;margin-bottom:8px">Refund Issued</div>
<p style="margin:0 0 18px;color:#64748b;font-size:13px">Order #<span style="font-family:ui-monospace,monospace">${esc(orderShort)}</span></p>

<table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px;margin-bottom:18px">
  ${summaryRow("Item", d.itemName)}
  ${summaryRow("Refund amount", `${d.refundAmountUsdc} USDC`, true)}
  ${summaryRow("Service fee (not refunded)", `${d.feeNotRefundedUsdc} USDC`)}
</table>

${reasonLine}

<div style="margin:16px 0;padding:12px 14px;background:#eff6ff;border-radius:10px;font-size:13px;color:#1e40af">
  <strong>Refund in transit.</strong> The USDC is on its way back to your wallet. It may take a few minutes to appear depending on network congestion.
</div>

${txLine}

${ctaButton("View Orders", `${appUrl}/orders`)}

<p style="margin:12px 0 0;color:#64748b;font-size:12px">Questions? Reply to this email or contact support.</p>`;

  const html = baseHtml({
    title: subject,
    previewText: `Refund of ${d.refundAmountUsdc} USDC issued for order #${orderShort}.`,
    bodyContent: body,
    appUrl,
    footerLinks: [
      { label: "My Orders", url: `${appUrl}/orders` },
      { label: "Support", url: `${appUrl}/help` },
    ],
  });

  return { subject, text, html };
}
