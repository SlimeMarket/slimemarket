import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { generateResetCode } from "@/lib/admin-auth";
import { sendTemplatedEmail } from "@/lib/notif/email";
import { pinResetTemplate } from "@/lib/notif/templates";

/**
 * POST /api/admin/pin/reset-request
 *
 * Sends a 6-digit reset code to the admin's registered email.
 * This is for the APP-LEVEL admin PIN (admin_pin_hash column), NOT the
 * Circle UCW PIN. The admin PIN guards sensitive actions (treasury,
 * fee collection, dispute resolution) via POST /api/admin/verify.
 *
 * NOT available via web dashboard — admin must call this endpoint directly
 * (curl / Postman / app internal flow). This prevents attackers who hijack
 * a web session from resetting the PIN without email access.
 *
 * No body needed — uses the authenticated user's email.
 */
export async function POST() {
  let user;
  try {
    user = await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  const code = generateResetCode(user.id);

  // Send via template system (Brevo HTTP API or SMTP fallback)
  let emailSent = false;
  try {
    const template = pinResetTemplate({
      resetCode: code,
      expiresMinutes: 10,
      appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://slimemarket.app",
    });
    const result = await sendTemplatedEmail(user.email, template);
    emailSent = result.sent;
    if (!result.sent) {
      console.error("[ADMIN PIN RESET] Email failed:", result.reason);
    }
  } catch (err: unknown) {
    console.error("[ADMIN PIN RESET] Email exception:", err instanceof Error ? err.message : String(err));
  }

  if (emailSent) {
    return jsonOk({ ok: true, message: `Reset code sent to ${user.email}` });
  }

  // Dev fallback: log code to console (never in production)
  if (process.env.NODE_ENV !== "production") {
    console.log(`[DEV] PIN reset code for ${user.email}: ${code}`);
    return jsonOk({ ok: true, message: `Reset code sent to ${user.email}`, dev_code: code });
  }

  return jsonError("Failed to send reset email", 500);
}
