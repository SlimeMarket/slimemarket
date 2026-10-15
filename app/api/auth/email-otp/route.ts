import { jsonError, jsonOk } from "@/lib/utils";
import { checkUserRateLimit } from "@/lib/rate-limit";
import { CIRCLE_BLOCKCHAIN } from "@/lib/arc";
import { asCircleBlockchain } from "@/lib/circle/ucw-user";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const CIRCLE_API = process.env.NEXT_PUBLIC_CIRCLE_BASE_URL ?? "https://api.circle.com";

async function verifyTurnstile(token: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Production MUST have TURNSTILE_SECRET_KEY set — hard fail.
    if (process.env.NODE_ENV === "production") return false;
    return true; // dev mode: skip verification if not configured
  }
  const resp = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
  });
  const data = await resp.json();
  return data.success === true;
}

/**
 * Turnstile is OPTIONAL and currently DISABLED (2026-09-27) to keep the launch
 * simple. Enforce it later by setting TURNSTILE_ENABLED=true — until then no
 * Turnstile token is required and neither key needs to be configured.
 */
function turnstileEnabled(): boolean {
  return process.env.TURNSTILE_ENABLED === "true";
}

/** Turnstile required only on bot-facing `request` (OTP send). */
async function requireTurnstile(body: Record<string, unknown>) {
  // Disabled by default — see turnstileEnabled().
  if (!turnstileEnabled()) return null;
  // Dev/local mode: skip Turnstile entirely (not production)
  if (process.env.NODE_ENV !== "production") {
    return null;
  }
  const turnstileToken = String(body.turnstileToken ?? "").trim();
  if (!turnstileToken) return jsonError("Turnstile token required", 403);
  const valid = await verifyTurnstile(turnstileToken);
  if (!valid) return jsonError("Turnstile verification failed", 403);
  return null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? (body.email && !body.otp ? "request" : "verify"));

  if (action === "request") {
    const blocked = await requireTurnstile(body);
    if (blocked) return blocked;

    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email) return jsonError("Email required", 400);

    // Rate limit: 3 OTP requests per hour per email to prevent spam/enumeration
    const rlErr = await checkUserRateLimit(email, "email-otp-request", {
      max: 3,
      windowMs: 60 * 60 * 1000, // 3 per hour per email
    });
    if (rlErr) return jsonError(`Too many OTP requests. Try again in an hour.`, 429);

    const deviceId = body.deviceId || `dev-${crypto.randomUUID().slice(0, 8)}`;

    const resp = await fetch(`${CIRCLE_API}/v1/w3s/users/email/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        deviceId,
        email,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) return jsonError(data.message || "Email OTP request failed", resp.status);

    return jsonOk({
      deviceToken: data.data.deviceToken,
      deviceEncryptionKey: data.data.deviceEncryptionKey,
      otpToken: data.data.otpToken,
      email,
      deviceId,
    });
  }

  if (action === "initialize") {
    // Post-OTP wallet init — user already passed Turnstile on `request`.
    const userToken = String(body.userToken ?? "");
    if (!userToken) return jsonError("userToken required", 400);

    const resp = await fetch(`${CIRCLE_API}/v1/w3s/user/initialize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        accountType: "EOA",
        blockchains: [asCircleBlockchain(CIRCLE_BLOCKCHAIN)],
      }),
    });

    const data = await resp.json();
    if (data.code === 155106) {
      return jsonOk({ alreadyInitialized: true });
    }
    if (!resp.ok) return jsonError(data.message || "User initialization failed", resp.status);
    return jsonOk({ challengeId: data.data.challengeId });
  }

  if (action === "walletList") {
    const userToken = String(body.userToken ?? "");
    if (!userToken) return jsonError("userToken required", 400);

    const resp = await fetch(`${CIRCLE_API}/v1/w3s/wallets`, {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
    });
    const data = await resp.json();
    if (!resp.ok) return jsonError(data.message || "List wallets failed", resp.status);
    return jsonOk({ wallets: data.data?.wallets ?? [] });
  }

  // Dev/local login bypass: when W3SSdk is not available on client,
  // FE sends action:"login" with email. We generate a dev userToken
  // so the flow can continue to /api/auth/unified.
  if (action === "login" && process.env.NODE_ENV !== "production") {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email) return jsonError("email required", 400);
    // Generate a dev token (not a real Circle token, but enough for local testing)
    const devToken = `dev-token-${crypto.randomUUID().slice(0, 8)}`;
    return jsonOk({
      ok: true,
      userToken: devToken,
      encryptionKey: "dev-encryption-key",
      email,
      message: "Dev login bypass (no OTP verification in dev mode)",
    });
  }

  return jsonError("unknown action", 400);
}
