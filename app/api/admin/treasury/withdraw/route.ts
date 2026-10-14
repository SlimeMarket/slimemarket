import { jsonError, jsonOk } from "@/lib/utils";
import { requireAdminAuth, checkAdminPin } from "@/lib/admin-auth";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { parseUsdc, formatUsdc } from "@/lib/money";
import { createMmAuditLog } from "@/lib/mm";
import { parseBody, TreasuryWithdrawBodySchema } from "@/lib/schemas";
import { createTransferChallenge } from "@/lib/ucw/transfer-challenge";
import { CIRCLE_USDC_TOKEN_ID } from "@/lib/arc";

/**
 * POST /api/admin/treasury/withdraw
 *
 * Withdraw from treasury (platform fees pool) to pay MM salary or operational costs.
 * Requires admin auth token (PIN + UCW verified) AND a FRESH per-action admin PIN
 * re-entry body.adminPin is verified against users.admin_pin_hash
 * BEFORE any treasury movement. 3 wrong entries → 15-min lockout.
 *
 * Body: {
 *   adminPin: string,            // REQUIRED — the acting admin's PIN, re-verified per request
 *   recipientUserId: string,     // user ID of MM/recipient
 *   amountUsdc: string,          // decimal USDC (e.g. "50.00")
 *   memo: string,                // reason (e.g. "MM salary July 2026")
 *   sourceAccount?: string,      // 'platform_fee' or 'gas_pool' (default: 'gas_pool')
 * }
 *
 * Debits from the specified fee account (platform_fee or gas_pool) and credits
 * recipient wallet. Uses treasury_payout_atomic for proper ledger accounting.
 */
export async function POST(req: Request) {
  // FIRST gate: admin session + X-Admin-Token (existing auth, unchanged).
  const auth = await requireAdminAuth(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }

  // Validate body. Rejects malformed recipientUserId UUIDs, negative amounts,
  // unknown sourceAccount values.
  const parsed = parseBody(TreasuryWithdrawBodySchema, body);
  if (parsed instanceof Response) return parsed;

  // SECOND gate fresh per-action admin PIN — checked BEFORE any
  // treasury movement. The acting admin's PIN state lives on their users row.
  const rawBody = body as { adminPin?: unknown };
  const adminPin = typeof rawBody.adminPin === "string" ? rawBody.adminPin : "";
  if (!adminPin) {
    return jsonError("adminPin is required — re-enter your admin PIN to confirm this withdrawal", 400, { code: "ADMIN_PIN_REQUIRED" });
  }

  const admin = supabaseAdminClient();
  const { data: adminRow } = await admin
    .from("users")
    .select("admin_pin_hash, pin_attempts, pin_locked_until")
    .eq("id", user.id)
    .single();
  if (!adminRow) return jsonError("admin user row not found", 403);

  const pinCheck = await checkAdminPin({
    storedHash: adminRow.admin_pin_hash ?? null,
    attempts: (adminRow.pin_attempts as number) ?? 0,
    lockedUntil: adminRow.pin_locked_until ?? null,
    pin: adminPin,
    now: new Date(),
  });

  if (!pinCheck.ok) {
    if (pinCheck.code === "ADMIN_PIN_NOT_SET") {
      return jsonError("Set your admin PIN first", 409, { code: "ADMIN_PIN_NOT_SET" });
    }
    if (pinCheck.code === "PIN_LOCKED") {
      // Persist the fresh lockout when the 3rd failure triggered it.
      if (((adminRow.pin_attempts as number) ?? 0) < 3 || !adminRow.pin_locked_until) {
        await admin.from("users").update({
          pin_attempts: 3,
          pin_locked_until: pinCheck.lockedUntil,
        }).eq("id", user.id);
      }
      return jsonError("PIN locked (3 failed attempts). Try again later or reset via email.", 423, {
        code: "PIN_LOCKED",
        lockedUntil: pinCheck.lockedUntil,
      });
    }
    // INVALID_PIN — persist the incremented attempt count.
    const newAttempts = (((adminRow.pin_attempts as number) ?? 0) + 1);
    await admin.from("users").update({ pin_attempts: newAttempts }).eq("id", user.id);
    return jsonError(`Invalid PIN. ${pinCheck.attemptsRemaining} attempt(s) remaining.`, 401, {
      code: "INVALID_PIN",
      attemptsRemaining: pinCheck.attemptsRemaining,
    });
  }

  // Correct PIN — reset attempts/lockout, then proceed with the withdrawal.
  await admin.from("users").update({ pin_attempts: 0, pin_locked_until: null }).eq("id", user.id);

  const source = parsed.sourceAccount ?? "gas_pool";
  const amountMicro = parseUsdc(parsed.amountUsdc);
  if (amountMicro <= 0n) return jsonError("amount must be positive", 400);

  // Verify recipient exists
  const { data: recipient } = await admin
    .from("users")
    .select("id, name, email")
    .eq("id", parsed.recipientUserId)
    .maybeSingle();
  if (!recipient) return jsonError("recipient user not found", 404);

  // Determine withdrawal destination: UCW address (if provided) or platform earnings transfer
  const targetAddress = parsed.targetWalletAddress;

  // Set by both branches; used by the shared audit log + response below.
  let txRow: { id: string } | null = null;

  if (targetAddress) {
    // UCW TRANSFER MODE: Withdraw platform earnings directly to specified Arc address.
    // Skip custodial ledger — this is a direct platform-to-external transfer.

    // Verify the platform wallet row exists (the source of platform earnings).
    // .A FIX: match on `circle_wallet_id` — `user_id` is the Supabase
    // user uuid, the env holds the CIRCLE wallet uuid, so the old .eq on
    // user_id never matched (branch always 500'd "platform wallet not configured").
    const { data: platformWallet } = await admin
      .from("wallets")
      .select("id, circle_wallet_id")
      .eq("circle_wallet_id", PLATFORM_WALLET_ID)
      .maybeSingle();

    if (!platformWallet) {
      return jsonError("platform wallet not configured", 500);
    }

    // Create the wallet_tx record for a direct on-chain send (not a bank transfer).

    // BUG FIX: this wrote method "external_transfer", which the
    // wallet_txs_method_check constraint does not allow (qris | card | bank |
    // onchain | cctp | internal | onchain-ucw), so the insert was rejected and
    // the withdrawal could never be recorded. The transfer goes through the
    // Circle UCW SDK, which is exactly what "onchain-ucw" denotes — it is also
    // the value lib/wallet/reconcile.ts keys on to resolve the Circle challenge.
    const { data: txRowUcw, error: txErr } = await admin
      .from("wallet_txs")
      .insert({
        wallet_id: platformWallet.id,
        type: "out",
        label: "Platform earnings withdrawal",
        sub: parsed.memo,
        amount: amountMicro,  // positive magnitude; direction comes from type:'out' (matches earnings/withdraw)
        status: "pending",
        method: "onchain-ucw",
        dest_address: targetAddress,
        idempotency_key: crypto.randomUUID(),
      })
      .select("id")
      .single();
    if (txErr || !txRowUcw) return jsonError(`wallet_tx insert failed: ${txErr?.message}`, 500);
    txRow = txRowUcw;

    // Direct USDC transfer using Circle UCW SDK (no bankAccountId needed)
    try {
      if (!CIRCLE_USDC_TOKEN_ID) {
        throw new Error("CIRCLE_USDC_TOKEN_ID not configured");
      }

      // Get admin's UCW userToken from httpOnly cookie
      const { cookies } = await import("next/headers");
      const cookieStore = await cookies();
      const userToken = cookieStore.get("circle_user_token")?.value;
      if (!userToken) {
        return jsonError("Admin UCW session expired — re-verify PIN", 401);
      }

      // .A FIX: Circle needs the CIRCLE wallet uuid (env /
      // circle_wallet_id), NOT the local DB row id (uuid) — the old value
      // targeted a wallet that does not exist in Circle.
      const { challengeId } = await createTransferChallenge({
        walletId: platformWallet.circle_wallet_id ?? PLATFORM_WALLET_ID,
        destinationAddress: targetAddress,
        amountDecimal: parsed.amountUsdc,
        tokenId: CIRCLE_USDC_TOKEN_ID,
        userToken,  // Admin's UCW session token from cookie
      });

      // Store challengeId for later settlement verification
      await admin.from("wallet_txs").update({
        ucw_challenge_id: challengeId,
      }).eq("id", txRow.id);

      // Audit BEFORE returning — the UCW branch returns early from inside try{}.
      await createMmAuditLog({
        mmUserId: user.id,
        mmWalletId: "treasury",
        actorType: "user",
        action: "TREASURY_WITHDRAW",
        refId: txRow.id,
        detail: {
          recipientUserId: parsed.recipientUserId,
          recipientName: recipient.name,
          amount: parsed.amountUsdc,
          memo: parsed.memo,
          sourceAccount: source,
          targetAddress,
        },
      });

      return jsonOk({
        ok: true,
        walletTxId: txRow.id,
        challengeId,
        targetAddress,
        amount: formatUsdc(amountMicro),
        memo: parsed.memo,
        note: "Transfer challenge created — await PIN approval via Circle hosted UI",
      });
    } catch (e) {
      return jsonError(`UCW transfer failed: ${(e as Error).message}`, 500);
    }
  } else {
    // TRADITIONAL MODE: Platform earnings to bankAccountId fallback (existing behavior)
    // Get recipient wallet
    const { data: recipientWallet } = await admin
      .from("wallets")
      .select("id")
      .eq("user_id", parsed.recipientUserId)
      .maybeSingle();
    if (!recipientWallet) return jsonError("recipient has no wallet", 400);

    // Create wallet_txs row (pending)
    const { data: txRowTrad, error: txErr } = await admin
      .from("wallet_txs")
      .insert({
        wallet_id: recipientWallet.id,
        type: "in",
        label: "Treasury payout",
        sub: parsed.memo,
        amount: amountMicro,
        status: "pending",
        method: "internal",
        idempotency_key: crypto.randomUUID(),
      })
      .select("id")
      .single();
    if (txErr || !txRowTrad) return jsonError(`wallet_tx insert failed: ${txErr?.message}`, 500);
    txRow = txRowTrad;

    // Use treasury_payout_atomic: DR fee account, CR user_wallet (proper ledger)
    const { error: payoutErr } = await admin.rpc("treasury_payout_atomic", {
      p_wallet_id: recipientWallet.id,
      p_amount: amountMicro.toString(),
      p_source_account: source,
      p_ref_id: txRow.id,
      p_wallet_tx_id: txRow.id,
    });
    if (payoutErr) return jsonError(`treasury payout failed: ${payoutErr.message}`, 500);
  }

  // Audit log (shared by both branches; UCW branch audits before its early return)
  if (!txRow) return jsonError("internal error: wallet_tx not created", 500);
  await createMmAuditLog({
    mmUserId: user.id,
    mmWalletId: "treasury",
    actorType: "user",
    action: "TREASURY_WITHDRAW",
    refId: txRow.id,
    detail: {
      recipientUserId: parsed.recipientUserId,
      recipientName: recipient.name,
      amount: parsed.amountUsdc,
      memo: parsed.memo,
      sourceAccount: source,
    },
  });

  return jsonOk({
    ok: true,
    walletTxId: txRow.id,
    recipient: { id: recipient.id, name: recipient.name },
    amount: formatUsdc(amountMicro),
    sourceAccount: source,
    memo: parsed.memo,
  });
}
