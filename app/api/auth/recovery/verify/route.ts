import { jsonOk, jsonError } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createMmAuditLog } from "@/lib/mm";
import { checkUserRateLimit } from "@/lib/rate-limit";
import {
  RECOVERY_PURPOSES,
  buildRecoveryMessage,
  consumeNonce,
  findUserByRecoveryWallet,
  recoveryDomainFromRequest,
  touchRecoveryWallet,
  verifyRecoverySignature,
} from "@/lib/auth/recovery";

/**
 * POST /api/auth/recovery/verify { address, nonce, signature }
 *
 * Exchanges a signed recovery challenge for a session. Guarantees, in order:
 *   1. the nonce exists, is unexpired, purpose-bound, and is consumed
 *      ATOMICALLY (single-use — replay of a captured signature fails);
 *   2. the signature really was produced by that EOA over the exact message
 *      the server issued (message is rebuilt from the DB row's issued_at, so
 *      the client cannot forge it);
 *   3. the EOA is actually registered as a recovery wallet, and the nonce
 *      (when bound to an account at issue time) matches that wallet's owner.
 *
 * Result: the SAME session cookies a normal login sets, so the existing
 * middleware/getCurrentUser path is reused unchanged. The session is marked
 * `recovered: true` and audited. Data access is restored; Circle-UCW money
 * actions still need a normal email-OTP login (see HANDOFF §14).
 */

/** Same cookie policy as /api/auth/unified (secure only over real HTTPS). */
function sessionCookieOpts(req: Request) {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: proto === "https",
    maxAge: 60 * 60 * 24 * 7, // 7 days, same as normal login
  };
}

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const address = String(body.address ?? "").trim();
  const nonce = String(body.nonce ?? "").trim();
  const signature = String(body.signature ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !nonce || !signature) {
    return jsonError("address, nonce and signature are required", 400);
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rlErr = await checkUserRateLimit(ip, "recovery-verify", {
    max: 10,
    windowMs: 10 * 60 * 1000,
  });
  if (rlErr) return jsonError("too many attempts — try again later", 429);

  // 1. Atomic single-use nonce. Every failure collapses to ONE generic 401 so
  //    the response cannot be used to probe nonce or account state.
  const consumed = await consumeNonce({
    nonce,
    purpose: RECOVERY_PURPOSES.LOGIN,
    address,
  });
  if (!consumed.ok || !consumed.issuedAt) {
    return jsonError("invalid recovery attempt", 401);
  }

  // 2. Signature check against the server-issued message.
  const message = buildRecoveryMessage({
    domain: recoveryDomainFromRequest(req),
    address,
    nonce,
    issuedAt: consumed.issuedAt,
    purpose: RECOVERY_PURPOSES.LOGIN,
  });
  if (!(await verifyRecoverySignature({ address, message, signature }))) {
    return jsonError("invalid recovery attempt", 401);
  }

  // 3. The EOA must be a registered recovery wallet, and (when the nonce was
  //    issued against an account) the same account.
  const walletOwner = await findUserByRecoveryWallet(address);
  if (!walletOwner) return jsonError("invalid recovery attempt", 401);
  if (consumed.userId && consumed.userId !== walletOwner.userId) {
    return jsonError("invalid recovery attempt", 401);
  }

  const admin = supabaseAdminClient();
  const { data: user } = await admin
    .from("users")
    .select("id, uid, name, handle, username, email, role, tx_count")
    .eq("id", walletOwner.userId)
    .maybeSingle();
  if (!user) return jsonError("invalid recovery attempt", 401);
  if ((user as Record<string, unknown>).banned === true) {
    return jsonError("account is banned", 403);
  }

  const { data: wallet } = await admin
    .from("wallets")
    .select("address, circle_wallet_id, usdc_balance")
    .eq("user_id", user.id)
    .maybeSingle();

  // Audit (best-effort: the login itself must not fail on audit problems) +
  // last_used stamp on the recovery wallet.
  await createMmAuditLog({
    mmUserId: user.id as string,
    mmWalletId: "recovery",
    actorType: "user",
    action: "RECOVERY_LOGIN",
    refId: user.id as string,
    detail: { address: address.toLowerCase(), method: "wallet-recovery" },
  }).catch(() => {});
  await touchRecoveryWallet(address);

  const res = jsonOk({
    user: {
      id: user.id,
      uid: user.uid,
      name: user.name,
      handle: user.handle,
      username: user.username ?? null,
      email: user.email,
      role: user.role,
      txCount: user.tx_count ?? 0,
    },
    wallet: wallet
      ? { address: wallet.address, circleWalletId: wallet.circle_wallet_id ?? null }
      : null,
    recovered: true,
    // UCW money actions still need email-OTP; the FE surfaces this limitation.
    recoveryLimitation:
      "Recovery session restores access to your orders, store and history. Actions that sign with your Slime Wallet still require a normal email-code login.",
  });

  const opts = sessionCookieOpts(req);
  // `circle_user_token` keeps the same name the middleware gate checks; the
  // value marks the session's origin (getCurrentUser never trusts it as a
  // credential — identity is resolved from circle_email + the DB row).
  res.cookies.set("circle_user_token", `recovery:${user.id}`, opts);
  res.cookies.set("circle_email", user.email as string, opts);
  return res;
}
