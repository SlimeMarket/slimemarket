/**
 * PIN reset code — sent when user requests a PIN reset.
 */
import { baseHtml, esc, EmailTemplateResult } from "./base";

export interface PinResetData {
  resetCode: string;
  expiresMinutes: number;
  appUrl?: string;
}

export function pinResetTemplate(d: PinResetData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const expires = d.expiresMinutes || 10;
  const subject = "SlimeMarket — PIN Reset Code";

  const text = `SlimeMarket PIN Reset

Your PIN reset code is: ${d.resetCode}

This code expires in ${expires} minutes.
If you didn't request this, ignore this email — your account is safe.

— SlimeMarket Security`;

  const body = `<div style="font-size:18px;font-weight:700;color:#0f172a;margin-bottom:12px">PIN Reset Code</div>

<p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.6">
  Use the code below to reset your PIN. This code expires in <strong>${expires} minutes</strong>.
</p>

<div style="margin:20px 0;padding:20px;background:#f1f5f9;border-radius:12px;text-align:center">
  <div style="font-family:ui-monospace,monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#0f172a">${esc(d.resetCode)}</div>
</div>

<div style="margin:16px 0;padding:12px 14px;background:#fffbeb;border-radius:10px;font-size:13px;color:#92400e;border-left:4px solid #f59e0b">
  <strong>Didn't request this?</strong> Ignore this email — your account is safe and no changes have been made.
</div>

<p style="margin:16px 0 0;color:#64748b;font-size:12px;line-height:1.5">
  For security, never share this code with anyone. SlimeMarket will never ask for your PIN or reset code via chat or phone.
</p>`;

  const html = baseHtml({
    title: subject,
    previewText: `Your PIN reset code is ${d.resetCode}. Expires in ${expires} minutes.`,
    bodyContent: body,
    appUrl,
    footerLinks: [
      { label: "Security", url: `${appUrl}/security` },
      { label: "Support", url: `${appUrl}/help` },
    ],
  });

  return { subject, text, html };
}
