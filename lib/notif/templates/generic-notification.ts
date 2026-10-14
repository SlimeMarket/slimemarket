/**
 * Generic notification — for any in-app notification that also needs email.
 */
import { baseHtml, ctaButton, esc, EmailTemplateResult } from "./base";

export interface GenericNotificationData {
  title: string;
  message: string;
  actionLabel?: string;
  actionUrl?: string;
  tone?: "info" | "success" | "warning" | "error";
  appUrl?: string;
}

export function genericNotificationTemplate(d: GenericNotificationData): EmailTemplateResult {
  const appUrl = d.appUrl || "https://slimemarket.app";
  const subject = d.title;

  const text = `${d.title}

${d.message}
${d.actionUrl ? `\n${d.actionUrl}` : ""}

— SlimeMarket`;

  const toneColors = {
    info:    { border: "#93c5fd", bg: "#eff6ff" },
    success: { border: "#6ee7b7", bg: "#ecfdf5" },
    warning: { border: "#fcd34d", bg: "#fffbeb" },
    error:   { border: "#fca5a5", bg: "#fef2f2" },
  };
  const c = toneColors[d.tone || "info"];

  const body = `<div style="font-size:18px;font-weight:700;color:#0f172a;margin-bottom:12px">${esc(d.title)}</div>

<div style="margin:16px 0;padding:14px 16px;background:${c.bg};border-left:4px solid ${c.border};border-radius:8px;font-size:14px;color:#334155;line-height:1.6">
  ${esc(d.message).replace(/\n/g, "<br>")}
</div>

${d.actionLabel && d.actionUrl ? ctaButton(d.actionLabel, d.actionUrl) : ""}

<p style="margin:12px 0 0;color:#64748b;font-size:12px">This is an automated notification from SlimeMarket.</p>`;

  const html = baseHtml({
    title: subject,
    previewText: d.message.slice(0, 100),
    bodyContent: body,
    appUrl,
  });

  return { subject, text, html };
}
