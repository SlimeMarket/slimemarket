/**
 * Dispute resolved — sent to the WINNER (buyer or seller).
 */
import { baseHtml, ctaButton, esc, summaryRow, EmailTemplateResult } from "./base";

export interface DisputeResolvedData {
  orderId: string;
  itemName: string;
  amountUsdc: string;
  winner: "buyer" | "seller";
  resolution: "refund" | "release" | "split";
  reason?: string;
  txHash?: string | null;
  explorerUrl?: string;
  appUrl?: string;
}

export function disputeResolvedTemplate(d: DisputeResolvedData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const orderShort = d.orderId.slice(0, 8);

  const resolutionLabels: Record<string, string> = {
    refund: "Refunded to buyer",
    release: "Released to seller",
    split: "Split between parties",
  };

  const subject = `Dispute Resolved — Order #${orderShort}`;

  const text = `The dispute has been resolved.

Order #${orderShort}
Item: ${d.itemName}
Amount: ${d.amountUsdc} USDC
Resolution: ${resolutionLabels[d.resolution] || d.resolution}
${d.reason ? `Reason: ${d.reason}` : ""}

The middleman has reviewed the case and made a determination. The escrow funds have been handled accordingly.
${d.txHash && d.explorerUrl ? `Transaction: ${d.explorerUrl}${d.txHash}` : ""}

View order: ${appUrl}/orders

— SlimeMarket`;

  const txLine = d.txHash && d.explorerUrl
    ? `<p style="margin:8px 0;font-size:12px;color:#475569">Transaction: <a href="${esc(d.explorerUrl + d.txHash)}" style="color:#0891b2;font-family:ui-monospace,monospace">${esc(d.txHash.slice(0, 18))}…</a></p>`
    : "";

  const reasonLine = d.reason
    ? `<p style="margin:8px 0;font-size:13px;color:#475569"><strong>Determination:</strong> ${esc(d.reason)}</p>`
    : "";

  const body = `<div style="font-size:20px;font-weight:700;color:#0f172a;margin-bottom:8px">Dispute Resolved</div>
<p style="margin:0 0 18px;color:#64748b;font-size:13px">Order #<span style="font-family:ui-monospace,monospace">${esc(orderShort)}</span></p>

<table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px;margin-bottom:18px">
  ${summaryRow("Item", d.itemName)}
  ${summaryRow("Amount", `${d.amountUsdc} USDC`)}
  ${summaryRow("Resolution", resolutionLabels[d.resolution] || d.resolution, true)}
</table>

${reasonLine}

<div style="margin:16px 0;padding:12px 14px;background:#ecfdf5;border-radius:10px;font-size:13px;color:#065f46">
  <strong>Case closed.</strong> The middleman has reviewed the dispute and the escrow funds have been handled according to the determination.
</div>

${txLine}

${ctaButton("View Order", `${appUrl}/orders`)}

<p style="margin:12px 0 0;color:#64748b;font-size:12px">This decision is final. For questions about the process, contact support.</p>`;

  const html = baseHtml({
    title: subject,
    previewText: `Dispute resolved for order #${orderShort}. ${resolutionLabels[d.resolution] || d.resolution}.`,
    bodyContent: body,
    appUrl,
    footerLinks: [
      { label: "My Orders", url: `${appUrl}/orders` },
      { label: "Support", url: `${appUrl}/help` },
    ],
  });

  return { subject, text, html };
}
