/**
 * Backup reminder — sent 7 days after registration if no recovery wallet is linked.
 */
import { baseHtml, ctaButton, esc, EmailTemplateResult } from "./base";

export interface BackupReminderData {
  name: string;
  appUrl?: string;
}

export function backupReminderTemplate(d: BackupReminderData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const subject = "Secure your SlimeMarket account — Link a recovery wallet";

  const text = `Hi ${d.name || "there"},

You created your SlimeMarket account a week ago. Your wallet and orders are protected by Circle's secure infrastructure, but there is one more step we recommend:

🔗 Link a Recovery Wallet

A recovery wallet is an external wallet (like MetaMask or Coinbase Wallet) that acts as a backup key to your account. If you ever lose access to your email, it lets you log back in and view your orders, store, and history.

Why this matters:
- Your Slime Wallet is managed by Circle — we cannot reset your PIN or email access
- A recovery wallet is the only way to regain account access without email
- It takes 30 seconds and costs nothing

Link now: ${appUrl}/settings/recovery

Important: A recovery wallet restores access to your account data. It does not move or control funds in your Slime Wallet — those remain secured by Circle.

— The SlimeMarket Team
${appUrl}`;

  const body = `<div style="font-size:18px;font-weight:700;color:#0f172a;margin-bottom:12px">Hi ${esc(d.name || "there")},</div>

<p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.6">
  You created your SlimeMarket account a week ago. Your wallet and orders are protected by Circle's secure infrastructure, but there is <strong>one more step</strong> we recommend:
</p>

<div style="margin:20px 0;padding:16px;background:#f8fafc;border-radius:10px;border-left:4px solid #0891b2">
  <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:8px">🔗 Link a Recovery Wallet</div>
  <p style="margin:0;color:#334155;font-size:13px;line-height:1.6">
    A recovery wallet is an external wallet (like MetaMask or Coinbase Wallet) that acts as a backup key to your account. If you ever lose access to your email, it lets you log back in and view your orders, store, and history.
  </p>
</div>

<div style="margin:16px 0;padding:12px 14px;background:#fffbeb;border-radius:10px;font-size:13px;color:#92400e;border-left:4px solid #f59e0b">
  <strong>Why this matters:</strong>
  <ul style="margin:8px 0 0;padding-left:18px;line-height:1.7">
    <li>Your Slime Wallet is managed by Circle — we cannot reset your PIN or email access</li>
    <li>A recovery wallet is the only way to regain account access without email</li>
    <li>It takes 30 seconds and costs nothing</li>
  </ul>
</div>

${ctaButton("Link Recovery Wallet", `${appUrl}/settings/recovery`)}

<div style="margin:16px 0;padding:12px 14px;background:#eff6ff;border-radius:10px;font-size:12px;color:#1e40af">
  <strong>Note:</strong> A recovery wallet restores access to your account data. It does not move or control funds in your Slime Wallet — those remain secured by Circle.
</div>

<p style="margin:16px 0 0;color:#64748b;font-size:12px;line-height:1.5">
  — The SlimeMarket Team
</p>`;

  const html = baseHtml({
    title: subject,
    previewText: `Secure your account with a recovery wallet — the only backup if you lose email access.`,
    bodyContent: body,
    appUrl,
    footerLinks: [
      { label: "Settings", url: `${appUrl}/settings/recovery` },
      { label: "Support", url: `${appUrl}/help` },
    ],
  });

  return { subject, text, html };
}
