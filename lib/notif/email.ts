/**
 * Email sender — env-gated, best-effort, never throws.
 *
 * TWO transports, tried in this order:
 *
 *   1. Brevo HTTP API  (`BREVO_API_KEY`)  → https://api.brevo.com/v3/smtp/email
 *   2. SMTP            (`SMTP_HOST` …)    → nodemailer
 *
 * WHY BREVO COMES FIRST — measured, not assumed. Many hosts block outbound SMTP
 * ports by default, so SMTP cannot deliver from production no matter what
 * credentials are configured:
 *
 *     from the server:  mail.example.com:465 TIMEOUT   :587 TIMEOUT
 *                       smtp.gmail.com:465   TIMEOUT   :587 TIMEOUT
 *                       mail.example.com:993 OK        :995 OK   ← host is fine
 *     from a laptop:    mail.example.com:465 OK        :587 OK
 *     from the server:  api.brevo.com:443    OK
 *
 * Note the IMAP/POP3 ports work: the mail server and the credentials are
 * healthy, it is purely the outbound SMTP port that is blocked. Some providers
 * unblock it on request, so `EMAIL_TRANSPORT=smtp` (or just removing
 * BREVO_API_KEY) switches back to Spacemail — which is cheaper at volume — with
 * no code change.
 *
 * Spacemail is still used, deliberately, for RECEIVING (the catch-all inbox that
 * Circle Console notifications land in). Two mail services, two jobs.
 *
 * Configure at deploy time:
 *   BREVO_API_KEY            — Brevo → SMTP & API → API Keys (starts with xkeysib-)
 *   SMTP_FROM                — must be a sender verified in Brevo (noreply@…)
 *   SMTP_HOST/PORT/USER/PASS — optional SMTP fallback
 */

export interface SendEmailArgs {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

import type { EmailTemplateResult } from "./templates";

/**
 * Send an email using a pre-built template.
 *
 * Convenience wrapper around `sendEmail` that unpacks a template result
 * (subject + text + html) so callers never forget to pass both versions.
 */
export async function sendTemplatedEmail(
  to: string,
  template: EmailTemplateResult,
): Promise<{ sent: boolean; reason?: string }> {
  return sendEmail({
    to,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
}

type Transport = "brevo" | "smtp";

/**
 * Which transport to try first.
 *
 *   EMAIL_TRANSPORT=brevo | smtp   → explicit, wins over everything
 *   EMAIL_TRANSPORT unset (auto)   → Brevo when BREVO_API_KEY is set, else SMTP
 *
 * The switch exists because SMTP egress is blocked at the PROVIDER, not by the
 * mail host: many hosts block outbound 25/465/587 by default. Measured — the
 * mail host itself is perfectly healthy:
 *
 *     from the server:  mail.example.com:993 OK, :995 OK, :465 TIMEOUT, :587 TIMEOUT
 *     from a laptop:    mail.example.com:465 OK, :587 OK
 *
 * Some providers unblock those ports on request, so Spacemail (cheaper at
 * volume) is a one-env-var switch once that ticket is done — no code change.
 */
function preferredTransport(): Transport {
  const explicit = (process.env.EMAIL_TRANSPORT || "").toLowerCase().trim();
  if (explicit === "brevo" || explicit === "smtp") return explicit;
  return process.env.BREVO_API_KEY ? "brevo" : "smtp";
}

const DEFAULT_FROM = "noreply@slimemarket.app";

function fromAddress(): string {
  // `||` (not `??`): env vars that are present but EMPTY (e.g. `SMTP_FROM=` in
  // .env) are "" — not nullish — so `??` would keep the empty string and build an
  // invalid From header like `"SlimeMarket" <>`.
  return process.env.SMTP_NOREPLY_FROM || process.env.SMTP_FROM || DEFAULT_FROM;
}

/** Brevo transactional email API. Returns `{sent:false}` when not configured. */
async function sendViaBrevo(
  args: SendEmailArgs,
): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.BREVO_API_KEY || "";
  if (!apiKey) return { sent: false, reason: "brevo not configured" };

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: fromAddress(), name: process.env.MAIL_FROM_NAME || "SlimeMarket" },
        to: [{ email: args.to }],
        subject: args.subject,
        // Brevo requires at least one of textContent / htmlContent.
        ...(args.text ? { textContent: args.text } : {}),
        ...(args.html ? { htmlContent: args.html } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { sent: false, reason: `brevo ${res.status}: ${body.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `brevo error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** SMTP via nodemailer. Returns `{sent:false}` when not configured. */
async function sendViaSmtp(
  args: SendEmailArgs,
): Promise<{ sent: boolean; reason?: string }> {
  const host = process.env.SMTP_HOST || "";
  const port = parseInt(process.env.SMTP_PORT || "465");
  const user = process.env.SMTP_NOREPLY_USER || process.env.SMTP_USER || "";
  const pass = process.env.SMTP_NOREPLY_PASS || process.env.SMTP_PASS || "";

  if (!host || !user || !pass) return { sent: false, reason: "smtp not configured" };

  try {
    // nodemailer is a real dependency (see package.json). Loaded dynamically so
    // the module graph stays lean on cold start and tests can run without it.
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host, port, secure: port === 465, auth: { user, pass },
    });
    await transporter.sendMail({
      from: `"SlimeMarket" <${fromAddress()}>`,
      to: args.to,
      subject: args.subject,
      text: args.text,
      // NEVER derive the HTML part from `text`.
      //
      // Callers build `text` by interpolating USER-CONTROLLED values — the
      // decline reason, the dispute reason, the appeal reason. `html: args.text`
      // therefore shipped those strings as live HTML, so a counterparty could
      // inject markup into a notification that arrives wearing the platform's
      // branding (`<a href="…">claim your refund</a>`). That is a phishing
      // vector, not a formatting nicety.
      //
      // `html` is opt-in: a caller that genuinely wants rich email must pass it
      // explicitly AND escape anything user-supplied itself. Undefined here
      // makes nodemailer send a plain-text message.
      html: args.html,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `smtp error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function sendEmail(args: SendEmailArgs): Promise<{ sent: boolean; reason?: string }> {
  const primary = preferredTransport();
  const order: Transport[] = primary === "brevo" ? ["brevo", "smtp"] : ["smtp", "brevo"];

  let informativeReason: string | undefined;

  for (const t of order) {
    const res = t === "brevo" ? await sendViaBrevo(args) : await sendViaSmtp(args);
    if (res.sent) return res;

    // Keep the first reason that describes a CONFIGURED-but-failed transport.
    // "not configured" is never the useful answer — it just means we never
    // intended to use that one.
    const notConfigured = /not configured/.test(res.reason ?? "");
    if (!notConfigured && informativeReason === undefined) informativeReason = res.reason;
    if (t === order[0]) console.error(`sendEmail via ${t} failed:`, res.reason);
  }

  const reason = informativeReason ?? "no email transport configured";
  if (reason === "no email transport configured" && process.env.NODE_ENV !== "production") {
    // Nothing is configured at all. Dev convenience log only — stay quiet in
    // production so a missing config never spams the logs per notification.
    console.log(`[DEV email → ${args.to}] ${args.subject}`);
  }
  return { sent: false, reason };
}
