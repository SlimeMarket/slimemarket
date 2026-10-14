import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { sendEmail, sendTemplatedEmail } from "./email";
import { sendTelegram } from "./telegram";
import type { EmailTemplateResult } from "./templates";

export type { EmailTemplateResult };
export { sendEmail, sendTemplatedEmail } from "./email";

/**
 * Unified notification dispatcher.
 *
 * ALWAYS creates a persistent in-app notification (notifications table) that the
 * user sees in the NotifBell (retrieved via GET /api/notifications). OPTIONALLY
 * sends a best-effort email + Telegram — both env-gated and non-blocking, so
 * missing SMTP/TG config never affects the app. Never throws.
 */
export interface NotifyInput {
  icon?: string;
  tone?: string; // slate | cyan | emerald | amber | rose | blue | violet
  title: string;
  text?: string;
  link?: string; // FE view id to navigate to (e.g. "orders", "seller")
  /**
   * Email delivery option:
   * - `true`              → send plain-text email using title + text
   * - `{subject, body}`   → send plain-text email with custom subject/body
   * - `EmailTemplateResult` → send rich HTML + text email from a template
   */
  email?: boolean | { subject: string; body?: string } | EmailTemplateResult;
  telegram?: boolean;
}

export async function notifyUser(userId: string, n: NotifyInput): Promise<void> {
  if (!userId) return;
  const admin = supabaseAdminClient();

  // 1) In-app notification (always) — this is the locally-verifiable core.
  try {
    await admin.from("notifications").insert({
      user_id: userId,
      icon: n.icon ?? "bell",
      tone: n.tone ?? "slate",
      title: n.title,
      text: n.text ?? null,
      read: false,
      link: n.link ?? null,
    });
  } catch (e) {
    console.error("notifyUser insert failed:", e instanceof Error ? e.message : String(e));
  }

  // 2) Best-effort email (deploy-time; no-op without SMTP config).
  if (n.email) {
    try {
      const { data: u } = await admin.from("users").select("email").eq("id", userId).maybeSingle();
      if (u?.email) {
        // If email is a template result, send rich HTML+text
        if (
          typeof n.email === "object" &&
          "subject" in n.email &&
          "text" in n.email &&
          "html" in n.email
        ) {
          await sendTemplatedEmail(u.email as string, n.email as EmailTemplateResult);
        } else {
          // Legacy: plain-text only
          const subject = typeof n.email === "object" ? n.email.subject : n.title;
          const body = typeof n.email === "object" ? (n.email.body ?? n.text ?? "") : (n.text ?? "");
          await sendEmail({ to: u.email as string, subject, text: body });
        }
      }
    } catch { /* non-blocking */ }
  }

  // 3) Best-effort Telegram to the admin channel (deploy-time; no-op without token).
  if (n.telegram) {
    try { await sendTelegram(`<b>${n.title}</b>${n.text ? "\n" + n.text : ""}`); } catch { /* non-blocking */ }
  }
}
