/**
 * Email template base layout and shared utilities.
 *
 * All templates return BOTH text and html so the transport can pick whichever
 * the user’s client prefers. The text version is hand-written, not derived from
 * HTML — automatic text extraction drops links and formatting that matter for
 * transactional emails (e.g. "confirm your order at https://…").
 *
 * SECURITY: every value interpolated into HTML is escaped via `esc()`. Product
 * names, store names, user input — all seller- or user-controlled — must not
 * reach the email body as live markup.
 */

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailTemplateResult {
  subject: string;
  text: string;
  html: string;
}

export interface BaseTemplateData {
  appUrl?: string;
  networkLabel?: string;
}

const DEFAULT_APP_URL = "https://slimemarket.app";

export function baseHtml(params: {
  title: string;
  previewText: string;
  bodyContent: string;
  footerLinks?: { label: string; url: string }[];
  appUrl?: string;
  networkLabel?: string;
}): string {
  const appUrl = esc(params.appUrl || DEFAULT_APP_URL);
  const year = new Date().getFullYear();

  const footerLinkHtml = (params.footerLinks || [])
    .map((l) => `<a href="${esc(l.url)}" style="color:#0891b2;text-decoration:none">${esc(l.label)}</a>`)
    .join(" &nbsp;|&nbsp; ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(params.title)}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; padding: 12px !important; }
      .content { padding: 20px 16px !important; }
      .button { width: 100% !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <!-- Preview text (hidden) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(params.previewText)}</div>
  <div style="display:none;max-height:0px;overflow:hidden">&#8199;&#847; &#8199;&#847; &#8199;&#847; &#8199;&#847; &#8199;&#847; &#8199;&#847;</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" style="padding:24px 12px">
        <table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:20px 24px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.3px">SlimeMarket</div>
                    <div style="color:#94a3b8;font-size:12px;margin-top:2px">On-chain escrow marketplace</div>
                  </td>
                  <td align="right" style="vertical-align:middle">
                    <div style="display:inline-block;background:#1e293b;border-radius:6px;padding:4px 10px;font-size:11px;color:#e2e8f0">${esc(params.networkLabel || "Arc Network")}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="content" style="padding:28px 24px 24px">
              ${params.bodyContent}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:12px;color:#94a3b8;line-height:1.6">
                    <div style="margin-bottom:8px">
                      <a href="${appUrl}" style="color:#0891b2;text-decoration:none;font-weight:500">${appUrl.replace(/^https:\/\//, "")}</a>
                    </div>
                    ${footerLinkHtml ? `<div style="margin-bottom:8px">${footerLinkHtml}</div>` : ""}
                    <div>&copy; ${year} SlimeMarket. All rights reserved.</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Build a prominent CTA button. */
export function ctaButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0">
    <tr>
      <td style="background:#0891b2;border-radius:10px;text-align:center">
        <a href="${esc(url)}" class="button" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;border-radius:10px">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

/** Build a status banner (colored box). */
export function statusBanner(
  text: string,
  tone: "success" | "warning" | "error" | "info" = "info",
): string {
  const colors = {
    success: { bg: "#ecfdf5", border: "#6ee7b7", text: "#065f46" },
    warning: { bg: "#fffbeb", border: "#fcd34d", text: "#92400e" },
    error:   { bg: "#fef2f2", border: "#fca5a5", text: "#991b1b" },
    info:    { bg: "#eff6ff", border: "#93c5fd", text: "#1e40af" },
  };
  const c = colors[tone];
  return `<div style="margin:18px 0;padding:12px 16px;background:${c.bg};border-left:4px solid ${c.border};border-radius:8px;font-size:13px;color:${c.text}">
    <strong>${esc(text)}</strong>
  </div>`;
}

/** A compact key/value row for order/deal summaries. */
export function summaryRow(label: string, value: string, strong = false): string {
  return `<tr>
    <td style="padding:5px 0;color:${strong ? "#0f172a" : "#475569"};${strong ? "font-weight:600;" : ""}font-size:13px">${esc(label)}</td>
    <td align="right" style="padding:5px 0;color:#0f172a;${strong ? "font-weight:700;font-size:14px;" : "font-size:13px;"}">${esc(value)}</td>
  </tr>`;
}
