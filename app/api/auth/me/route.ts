import { getCurrentUser, getUcwCredentials, isDevTokenSession } from "@/lib/auth-ucw";
import { jsonOk, jsonError } from "@/lib/utils";
import { getCircleUserStatus, challengeForProvisioningAction } from "@/lib/circle/ucw-user";
import { decideProvisioning } from "@/lib/circle/ucw-provisioning";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile from session cookies.
 * Used by the SPA on reload to restore ME without re-login.
 * 401 if session expired.
 *
 * PIN provisioning is evaluated for EVERY real (non-dev) session,
 * not just `walletProvisioned === false` accounts. This closes the legacy gap
 * (Rimuru: wallet exists but pinStatus UNSET → checkout had no PIN to prompt).
 * The decision comes from decideProvisioning(pinStatus, hasWallet):
 *   - UNSET + no wallet  → full challenge (PIN + wallet)
 *   - UNSET + wallet     → PIN-only challenge (legacy accounts)
 *   - ENABLED + no wallet→ wallet-only challenge
 *   - ENABLED + wallet   → silently fix wallet_provisioned flag if missed
 * Returns `{ needsPinSetup: true, pinSetupChallengeId }` when a challenge is
 * offered. NEVER fails the request: any Circle error is swallowed and logged.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  // evaluate pinStatus for ALL real sessions (old
  // `walletProvisioned === false` gate removed: it skipped legacy accounts
  // that had a wallet but never set a PIN).
  let pinSetup:
    | { needsPinSetup: true; pinSetupChallengeId: string; pinSetupAction: string }
    | null = null;
  try {
    const devSession = await isDevTokenSession();
    if (!devSession) {
      const creds = await getUcwCredentials();
      if (creds) {
        const status = await getCircleUserStatus(creds.userToken);
        // DEBUG: log so we can verify Circle email-auth really sets pinStatus=ENABLED
        console.log("[auth/me] pinStatus=", status.pinStatus, "hasWallet=", !!user.walletAddress && !!user.circleWalletId && user.circleWalletId !== "pending-provisioning", "uid=", user.uid);
        const decision = decideProvisioning({
          pinStatus: status.pinStatus,
          // BUG FIX: dev-login writes the literal placeholder
          // `circle_wallet_id = "pending-provisioning"` (see
          // app/api/auth/dev-login/route.ts), and the column is NOT NULL so it
          // cannot simply be cleared. A plain truthiness check therefore reports
          // hasWallet=true for a user whose Circle wallet was never created —
          // so decideProvisioning returns "pin-only-challenge" instead of
          // "full-challenge", the app only asks for a PIN, and the wallet is
          // never provisioned. Real UCW login then keeps failing with
          // "wallet not created yet" / an empty Circle wallet list.
          // FIX: a wallet row with a placeholder id but null address is NOT a
          // real wallet. Use walletAddress (the on-chain address) as the source
          // of truth for "does this user have a wallet?".
          hasWallet: !!user.walletAddress && !!user.circleWalletId && user.circleWalletId !== "pending-provisioning",
        });
        const challenge = await challengeForProvisioningAction(decision, creds.userToken);
        if (challenge) {
          // `pinSetupAction` tells the FE WHAT this challenge actually does.
          // 'wallet-only-challenge' creates a wallet — it does NOT set a PIN —
          // so the gate must not claim "set up your PIN" (see public/app.jsx).
          pinSetup = {
            needsPinSetup: true,
            pinSetupChallengeId: challenge.challengeId,
            pinSetupAction: decision,
          };
        } else if (decision === "done" && !user.walletProvisioned) {
          // PIN enabled + wallet exists but the flag was never set — fix it
          // silently so this doesn't re-trigger on every load.
          await supabaseAdminClient()
            .from("users")
            .update({ wallet_provisioned: true })
            .eq("id", user.id);
        }
      }
    }
  } catch (e) {
    // Never block session restore on provisioning failures.
    console.error("[auth/me] PIN provisioning check failed (continuing):", e);
  }

  return jsonOk({
    id: user.id,
    uid: user.uid,
    name: user.name,
    username: user.username,
    handle: user.handle,
    email: user.email,
    role: user.role,
    txCount: user.txCount,
    avatarUrl: user.avatarUrl,
    avatarGradient: user.avatarGradient,
    bannerGradient: user.bannerGradient,
    preferredLang: user.preferredLang,
    contacts: user.contacts,
    joinedAt: user.joinedAt,
    circleUserId: user.circleUserId,
    walletAddress: user.walletAddress,
    circleWalletId: user.circleWalletId,
    ...(pinSetup ?? {}),
  });
}
