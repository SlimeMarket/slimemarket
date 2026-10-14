/**
 * Welcome email — sent after a user completes registration.
 */
import { baseHtml, ctaButton, esc, EmailTemplateResult } from "./base";

export interface WelcomeData {
  name: string;
  appUrl?: string;
}

export function welcomeTemplate(d: WelcomeData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const subject = "Welcome to SlimeMarket — Your On-chain Marketplace";

  const text = `Hi ${d.name || "there"},

Welcome to SlimeMarket! You're now part of a marketplace where every deal is protected by on-chain escrow.

What you can do next:
• Browse listings and discover digital goods
• Top up your wallet with USDC
• Start buying or selling with trustless escrow

Your account is secured by your wallet — no passwords to remember, no seed phrases to share.

Get started: ${appUrl}

If you have any questions, reply to this email or visit our help center.

— The SlimeMarket Team`;

  const body = `<div style="font-size:20px;font-weight:700;color:#0f172a;margin-bottom:12px">Welcome aboard, ${esc(d.name || "there")}!</div>

<p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.6">
  You have successfully joined <strong>SlimeMarket</strong> — the on-chain escrow marketplace where buyers and sellers trade with confidence.
</p>

<div style="margin:20px 0;padding:16px;background:#f8fafc;border-radius:10px">
  <div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:10px">What you can do next:</div>
  <ul style="margin:0;padding-left:20px;color:#334155;font-size:13px;line-height:1.8">
    <li>Browse listings and discover digital goods</li>
    <li>Top up your wallet with USDC</li>
    <li>Start buying or selling with trustless escrow</li>
  </ul>
</div>

<p style="margin:16px 0;color:#334155;font-size:14px;line-height:1.6">
  Your account is secured by your wallet — no passwords to remember, no seed phrases to share.
</p>

${ctaButton("Get Started", appUrl)}

<p style="margin:16px 0 0;color:#64748b;font-size:12px;line-height:1.5">
  If you have any questions, reply to this email or visit our help center.
</p>`;

  const html = baseHtml({
    title: subject,
    previewText: `Welcome to SlimeMarket, ${d.name || "there"}! Start trading with on-chain escrow protection.`,
    bodyContent: body,
    appUrl,
  });

  return { subject, text, html };
}
