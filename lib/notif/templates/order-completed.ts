/**
 * Order completed / funds released — sent to the SELLER.
 */
import { baseHtml, ctaButton, esc, summaryRow, EmailTemplateResult } from "./base";

export interface OrderCompletedData {
  orderId: string;
  itemName: string;
  amountUsdc: string;
  feeUsdc: string;
  netUsdc: string;
  txHash?: string | null;
  explorerUrl?: string;
  appUrl?: string;
}

export function orderCompletedTemplate(d: OrderCompletedData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const orderShort = d.orderId.slice(0, 8);
  const subject = `Funds Released — Order #${orderShort}`;

  const text = `Your payout has been released!

Order #${orderShort}
Item: ${d.itemName}
Gross amount: ${d.amountUsdc} USDC
Platform fee (2%): ${d.feeUsdc} USDC
Net received: ${d.netUsdc} USDC

The buyer confirmed delivery and the escrow contract has released the funds to your earnings.
${d.txHash && d.explorerUrl ? `Transaction: ${d.explorerUrl}${d.txHash}` : ""}

View earnings: ${appUrl}/seller

— SlimeMarket`;

  const txLine = d.txHash && d.explorerUrl
    ? `<p style="margin:8px 0;font-size:12px;color:#475569">Transaction: <a href="${esc(d.explorerUrl + d.txHash)}" style="color:#0891b2;font-family:ui-monospace,monospace">${esc(d.txHash.slice(0, 18))}…</a></p>`
    : "";

  const body = `<div style="font-size:20px;font-weight:700;color:#0f172a;margin-bottom:8px">Funds Released</div>
<p style="margin:0 0 18px;color:#64748b;font-size:13px">Order #<span style="font-family:ui-monospace,monospace">${esc(orderShort)}</span></p>

<table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px;margin-bottom:18px">
  ${summaryRow("Item", d.itemName)}
  ${summaryRow("Gross amount", `${d.amountUsdc} USDC`)}
  ${summaryRow("Platform fee (2%)", `${d.feeUsdc} USDC`)}
  ${summaryRow("Net received", `${d.netUsdc} USDC`, true)}
</table>

<div style="margin:16px 0;padding:12px 14px;background:#ecfdf5;border-radius:10px;font-size:13px;color:#065f46">
  <strong>Payout complete.</strong> The buyer confirmed delivery and the escrow contract has released the funds to your earnings.
</div>

${txLine}

${ctaButton("View Earnings", `${appUrl}/seller`)}

<p style="margin:12px 0 0;color:#64748b;font-size:12px">Funds are available in your SlimeMarket wallet.</p>`;

  const html = baseHtml({
    title: subject,
    previewText: `Payout of ${d.netUsdc} USDC released for order #${orderShort}.`,
    bodyContent: body,
    appUrl,
    footerLinks: [
      { label: "Seller Dashboard", url: `${appUrl}/seller` },
      { label: "Transactions", url: `${appUrl}/seller` },
    ],
  });

  return { subject, text, html };
}
