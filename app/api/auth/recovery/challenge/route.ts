import { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth-ucw";
import { checkUserRateLimit } from "@/lib/rate-limit";
import {
  RECOVERY_PURPOSES,
  buildRecoveryMessage,
  issueNonce,
  recoveryDomainFromRequest,
  type RecoveryPurpose,
} from "@/lib/auth/recovery";

/**
 * POST /api/auth/recovery/challenge { address, purpose? }
 *
 * Issues a single-use nonce (10 min) + the exact message the wallet must sign.
 * The response is intentionally identical whether or not the address is
 * registered (no account enumeration); the rejection happens later, in /verify.
 *
 * purpose 'recovery_login' (default) is open to anyone; 'link_wallet' requires
 * a live session (managing your own recovery wallets).
 */
export const dynamic = "force-dynamic";

const ALLOWED_PURPOSES: RecoveryPurpose[] = [
  RECOVERY_PURPOSES.LOGIN,
  RECOVERY_PURPOSES.LINK,
];

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const address = String(body.address ?? "").trim();
  const purpose = (String(body.purpose ?? RECOVERY_PURPOSES.LOGIN) as RecoveryPurpose);

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return jsonError("valid evm address required", 400);
  if (!ALLOWED_PURPOSES.includes(purpose)) return jsonError("unknown purpose", 400);

  // Rate limit the unauthenticated recovery path harder than normal login:
  // 5 challenges per 10 minutes per IP.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rlErr = await checkUserRateLimit(ip, "recovery-challenge", {
    max: 5,
    windowMs: 10 * 60 * 1000,
  });
  if (rlErr) return jsonError("too many recovery attempts — try again later", 429);

  let userId: string | null = null;
  if (purpose === RECOVERY_PURPOSES.LINK) {
    const user = await getCurrentUser();
    if (!user) return jsonError("unauthorized", 401);
    if (user.banned) return jsonError("account is banned", 403);
    userId = user.id;
  }

  try {
    const { nonce, issuedAt, expiresAt } = await issueNonce({
      purpose,
      address,
      userId,
    });
    const message = buildRecoveryMessage({
      domain: recoveryDomainFromRequest(req),
      address,
      nonce,
      issuedAt,
      purpose,
    });
    return jsonOk({ nonce, issuedAt, expiresAt, purpose, message });
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}
