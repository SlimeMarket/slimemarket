import { requireUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonOk, jsonError , dbErrorMessage } from "@/lib/utils";
import { listUserWallets, getCircleUserStatus, UcwError } from "@/lib/circle/ucw-user";
import { pickArcWallet } from "@/lib/circle/ucw-provisioning";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * POST /api/wallet/ucw-provisioning-complete — .B2.
 *
 * Called by the FE right after the hosted-UI PIN-setup challenge succeeds.
 * Server re-reads the user's wallets from Circle, picks the ARC-TESTNET one,
 * upserts the local `wallets` row (replacing any legacy/broken row for this
 * user), and flips `users.wallet_provisioned` to true.
 *
 * Idempotent: safe to call repeatedly — the upsert is keyed on the UNIQUE
 * wallets.user_id constraint and the flag update is a no-op when already set.
 *
 * Errors:
 *   401 — no session
 *   401 (clean message) — UCW credentials missing → refresh session
 *   409 — no ARC-TESTNET wallet created yet (challenge incomplete / async)
 *   502 — upstream Circle failure
 */
export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 401;
    return jsonError("unauthorized", status);
  }
  if (user.banned) return jsonError("account is banned", 403);

  const creds = await getUcwCredentials();
  if (!creds) {
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  let wallets;
  try {
    wallets = await listUserWallets(creds.userToken);
  } catch (e) {
    const err = e instanceof UcwError ? e : new UcwError("listUserWallets failed", undefined, 502);
    return jsonError(dbErrorMessage("wallet/ucw-provisioning-complete", err), err.httpStatus ?? 502);
  }

  const picked = pickArcWallet(wallets);
  if (!picked || !picked.address) {
    return jsonError("wallet not created yet", 409);
  }

  // FIX (2026-09-27): VERIFY the PIN was actually set before claiming success.
  // A wallet row can already exist (legacy account, or an earlier partial
  // attempt) while Circle's pinStatus is still UNSET. The route used to flip
  // `wallet_provisioned` on wallet existence alone, so the UI announced
  // "Your PIN is set" even though no PIN existed and no security questions were
  // chosen. Require pinStatus ENABLED — otherwise the gate stays open.
  try {
    const status = await getCircleUserStatus(creds.userToken);
    if (status.pinStatus !== "ENABLED") {
      return jsonError(
        `PIN not set yet (pinStatus=${status.pinStatus}) — finish the PIN setup to continue.`,
        409,
      );
    }
  } catch (e) {
    const err = e instanceof UcwError ? e : new UcwError("getUserStatus failed", undefined, 502);
    return jsonError(dbErrorMessage("wallet/ucw-provisioning-complete", err), err.httpStatus ?? 502);
  }

  const admin = supabaseAdminClient();

  // Replace any legacy/broken row for this user (keyed on UNIQUE user_id).
  const { error: upsertErr } = await admin
    .from("wallets")
    .upsert(
      {
        user_id: user.id,
        address: picked.address,
        circle_wallet_id: picked.id ?? "",
        wallet_type: "ucw",
      },
      { onConflict: "user_id" },
    );
  if (upsertErr) return jsonError(upsertErr.message, 500);

  const { error: flagErr } = await admin
    .from("users")
    .update({ wallet_provisioned: true })
    .eq("id", user.id);
  if (flagErr) return jsonError(flagErr.message, 500);

  return jsonOk({ ok: true, address: picked.address, walletId: picked.id ?? null });
}
