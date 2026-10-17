import { randomUUID } from "crypto";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { arcPublicClient } from "@/lib/arc";
import { resolveUsdcTokenIds } from "@/lib/circle/usdc-token";
import { explainCircleError, isCircleFailure, waitForCircleTx } from "@/lib/circle/tx-state";
import { gasReserveMicro } from "@/lib/wallet/gas";
import type { CurrentUser } from "@/lib/auth-ucw";
import { parseUsdc, formatUsdc } from "@/lib/money";
import { validateArcAddress } from "@/lib/arc";
import { isBlocklisted } from "./blocklist";
import { createTransferChallenge } from "@/lib/ucw/transfer-challenge";
import type { Hex } from "viem";

/**
 * PIN-gated UCW send/withdraw.
 *
 * Real-mode withdraw: funds move FROM THE USER'S OWN UCW wallet via a Circle
 * TRANSFER challenge signed with their PIN (W3SSdk) — a compromised email
 * session alone can no longer drain funds. The legacy platform-DCW reimburse
 * path (crypto-withdraw.ts) stays for dev/mock sessions.
 *
 * Ledger model with ONCHAIN_WALLET_FUNDS=1: the DB ledger is a *mirror*; the
 * chain is the source of truth. We record a `wallet_txs` row at challenge
 * time (pending) and flip it to done with the on-chain hash at settle time.
 * The mirror debit is best-effort (never fails the send) — in custodial mode
 * the ledger is credited so the debit balances it; in on-chain mode the
 * ledger was never credited so the debit harmlessly no-ops/fails.
 *
 * Money = bigint micro-USDC.
 */

export interface PreflightResult {
  dest: string; // checksummed destination
  amountMicro: bigint;
  walletId: string; // local wallets.id
}

/**
 * Shared validation for any crypto withdraw: amount, address format,
 * blocklist screen, daily limit, wallet row lookup. Throws with a plain
 * message on failure (route maps it to 400/422). NO state mutation.
 */
export async function preflightCryptoWithdraw(args: {
  user: CurrentUser;
  destAddress: string;
  amountUsdc: string;
}): Promise<PreflightResult> {
  const { user, destAddress, amountUsdc } = args;
  const amountMicro = parseUsdc(amountUsdc);
  if (amountMicro <= 0n) throw new Error("amount must be positive");

  const dest = validateArcAddress(destAddress); // throws on malformed

  if (await isBlocklisted(dest)) {
    throw new Error("destination address is blocklisted or invalid");
  }

  const admin = supabaseAdminClient();
  const { error: limitErr } = await admin.rpc("check_daily_withdraw_limit", {
    p_user_id: user.id,
    p_amount: amountMicro.toString(),
  });
  if (limitErr) throw new Error(`withdrawal limit: ${limitErr.message}`);

  const { data: wallet, error: wErr } = await admin
    .from("wallets")
    .select("id, address")
    .eq("user_id", user.id)
    .maybeSingle();
  if (wErr || !wallet) throw new Error("wallet not found for user");

  // Arc pays gas in USDC out of the SAME balance, so a send that leaves too
  // little behind passes validation and then fails inside Circle AFTER the user
  // has approved it with their PIN (INSUFFICIENT_NATIVE_TOKEN). Catch it here,
  // before anything is signed.
  if (wallet.address) {
    try {
      const client = arcPublicClient();
      const [balanceWei, gasPrice] = await Promise.all([
        client.getBalance({ address: wallet.address as Hex }),
        client.getGasPrice(),
      ]);
      const balanceMicro = balanceWei / 10n ** 12n;
      const reserve = gasReserveMicro(gasPrice);
      if (amountMicro + reserve > balanceMicro) {
        throw new Error(
          `Not enough USDC for this amount plus the network fee — leave at least ${formatUsdc(reserve)} USDC for gas`,
        );
      }
    } catch (e) {
      // Only the explicit shortfall above should block. A flaky balance read
      // must not: Circle stays the authority, and settle() now reports a real
      // failure instead of leaving the row pending.
      if (e instanceof Error && /^Not enough USDC/.test(e.message)) throw e;
      console.warn("[preflight] balance check skipped:", e instanceof Error ? e.message : e);
    }
  }

  return { dest, amountMicro, walletId: wallet.id };
}

export interface UcwSendChallengeResult {
  mode: "ucw-challenge";
  challengeId: string;
  walletTxId: string;
}

/**
 * Real mode: create the UCW TRANSFER challenge (PIN prompt on the user's
 * device) and record the pending wallet_tx row. NO ledger debit yet — funds
 * only move when the user approves and the tx lands on-chain (settle).
 */
export async function initiateUcwSendChallenge(args: {
  user: CurrentUser;
  dest: string;
  amountMicro: bigint;
  walletId: string;
  circleWalletId: string;
  userToken: string;
}): Promise<UcwSendChallengeResult> {
  const { user, dest, amountMicro, walletId, circleWalletId, userToken } = args;

  // Token id comes from the wallet's own balance list, not from the env alone:
  // on Arc the entity exposes both native USDC (18 dp) and the ERC-20 interface
  // (6 dp), and a placeholder env value makes Circle reject the transfer with
  // the opaque "API parameter invalid" the user saw on /wallet.
  const tokenIds = await resolveUsdcTokenIds(circleWalletId);
  const amountDecimal = formatUsdc(amountMicro);

  let challengeId = "";
  let circleTxId: string | null = null;
  let lastErr: unknown = null;
  for (const tokenId of tokenIds) {
    try {
      const res = await createTransferChallenge({
        walletId: circleWalletId,
        destinationAddress: dest,
        amountDecimal,
        tokenId,
        userToken,
      });
      challengeId = res.challengeId;
      circleTxId = res.transactionId;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Circle answers an unusable token id with a 400 "API parameter invalid".
      // Arc exposes the same USDC as native (18 dp) and ERC-20 (6 dp), so try
      // the other representation before failing the user's send.
      if (!/parameter invalid|invalid token|token not found/i.test(msg)) throw e;
      console.warn(`[ucw-send] Circle rejected token ${tokenId}, trying next variant`);
    }
  }
  if (lastErr) throw lastErr;

  const admin = supabaseAdminClient();
  const { data: txRow, error: txErr } = await admin
    .from("wallet_txs")
    .insert({
      wallet_id: walletId,
      type: "out",
      // Just "Withdraw" — the old "Withdraw (on-chain · PIN)" surfaced an
      // implementation detail (which challenge type was used) in the user's own
      // transaction list, which is noise for them. The method column still
      // records `onchain-ucw` for ops.
      label: "Withdraw",
      sub: `to ${dest.slice(0, 8)}…${dest.slice(-4)}`,
      amount: amountMicro,
      status: "pending",
      // a DISTINCT method for the UCW-challenge path. These rows are
      // settled by the FE calling back with the on-chain txHash; if the browser
      // dies first, the row would otherwise sit 'pending' forever and — because
      // the DCW reconciler requires a Circle tx id it never had — stay invisible
      // to every sweep. The separate method lets `reconcileStaleUcwSends` find
      // them, and keeps them out of the DCW path's scan (which would try to look
      // up a challenge id as a transaction).
      method: "onchain-ucw",
      idempotency_key: randomUUID(),
      // Store the Circle TRANSACTION id (falling back to the challenge id): the
      // transaction id is what lets us ask Circle whether the transfer actually
      // landed or failed, both at settle time and from the reconciler.
      circle_tx_id: circleTxId || challengeId,
    })
    .select("id")
    .single();
  if (txErr || !txRow) {
    throw new Error(`insert wallet_tx failed: ${txErr?.message}`);
  }
  void user; // user scope kept for audit symmetry with the legacy path

  return { mode: "ucw-challenge", challengeId, walletTxId: txRow.id };
}

export interface SettleResult {
  ok: boolean;
  status: "done" | "failed" | "cancelled" | "pending";
  arcTxHash: string | null;
  error?: string;
}

/**
 * Settle a UCW send after the FE completes (or cancels) the challenge.
 *
 * Done path: verify the on-chain receipt (success + originated from the
 * user's own wallet — rejects a forged txHash pointing at an unrelated tx),
 * then flip the wallet_tx to done and best-effort mirror-debit the ledger.
 *
 * Cancel path: mark the wallet_tx failed (nothing moved on-chain).
 */
export async function settleUcwSend(args: {
  user: CurrentUser;
  walletTxId: string;
  txHash?: string | null;
  cancelled?: boolean;
}): Promise<SettleResult> {
  const { user, walletTxId, txHash, cancelled } = args;
  const admin = supabaseAdminClient();

  const { data: txRow } = await admin
    .from("wallet_txs")
    .select("id, wallet_id, amount, status, circle_tx_id")
    .eq("id", walletTxId)
    .maybeSingle();
  if (!txRow) return { ok: false, status: "failed", arcTxHash: null, error: "wallet_tx not found" };
  if (txRow.status === "done") {
    return { ok: true, status: "done", arcTxHash: null, error: "already settled" };
  }

  // Ownership: the tx's wallet must belong to the caller.
  const { data: wallet } = await admin
    .from("wallets")
    .select("user_id, address")
    .eq("id", txRow.wallet_id)
    .maybeSingle();
  if (!wallet || wallet.user_id !== user.id) {
    return { ok: false, status: "failed", arcTxHash: null, error: "not your withdrawal" };
  }

  if (cancelled) {
    // Explicit cancellation reported by the FE. Still mark it failed — but note
    // that Circle may have submitted the transfer anyway (its hosted UI can
    // report an error AFTER the transaction was signed), so the row stays
    // reconcilable: the `transactions.inbound`/`outbound` webhook handler and
    // the stale-send reconciler both promote a matching row back to `done`.
    await admin.from("wallet_txs").update({ status: "failed" }).eq("id", walletTxId);
    return { ok: false, status: "cancelled", arcTxHash: null };
  }

  // Resolve the outcome from Circle when the browser could not supply a hash.
  // Circle's challenge result never carries one, so a FAILED transfer (the
  // common case on Arc: INSUFFICIENT_NATIVE_TOKEN, since USDC is the gas token)
  // used to look identical to a slow one and the row sat PENDING forever.
  let resolvedHash: string | null = txHash ?? null;
  if (!resolvedHash && txRow.circle_tx_id) {
    const state = await waitForCircleTx(txRow.circle_tx_id);
    if (state) {
      if (isCircleFailure(state.state)) {
        console.warn(
          `[ucw-send] Circle tx ${txRow.circle_tx_id} ${state.state}: ${state.errorReason ?? "no reason"}`,
        );
        await admin.from("wallet_txs").update({ status: "failed" }).eq("id", walletTxId);
        return {
          ok: false,
          status: "failed",
          arcTxHash: null,
          error: explainCircleError(state.errorReason),
        };
      }
      if (state.state === "COMPLETE" && state.txHash) resolvedHash = state.txHash;
    }
  }

  if (!resolvedHash) {
    // Still in flight (or Circle unreachable). Stay PENDING; the reconciler and
    // the webhook settle it from the authoritative side.
    return { ok: true, status: "pending", arcTxHash: null };
  }

  // Verify on-chain: receipt must exist, be successful, and originate from
  // the user's own wallet address.
  try {
    const receipt = await arcPublicClient().getTransactionReceipt({ hash: resolvedHash as Hex });
    if (!receipt || receipt.status !== "success") {
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", walletTxId);
      return { ok: false, status: "failed", arcTxHash: resolvedHash, error: "on-chain transfer not successful" };
    }
    const from = (receipt.from || "").toLowerCase();
    const own = (wallet.address || "").toLowerCase();
    if (own && from !== own) {
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", walletTxId);
      return { ok: false, status: "failed", arcTxHash: resolvedHash, error: "tx did not originate from your wallet" };
    }
  } catch (e) {
    // RPC unavailable or unknown hash — leave pending; reconcile job retries.
    console.error("[ucw-send] receipt verification failed:", e);
    return { ok: false, status: "failed", arcTxHash: resolvedHash, error: "could not verify on-chain tx (will reconcile)" };
  }

  // On-chain success confirmed. Best-effort ledger mirror debit: in custodial
  // mode this decrements the authoritative ledger (debit_wallet_atomic flips
  // the pending wallet_tx to 'done' itself — it requires status='pending',
  // which is exactly our state here). In on-chain mode the ledger may hold
  // no balance (money lives on-chain) → the RPC raises 'insufficient', we
  // swallow it and mark done manually below.
  try {
    await admin.rpc("debit_wallet_atomic", {
      p_wallet_id: txRow.wallet_id,
      p_amount: String(txRow.amount),
      p_ref_id: txRow.id,
      p_wallet_tx_id: txRow.id,
    });
  } catch (e) {
    console.warn("[ucw-send] mirror debit skipped (on-chain mode):", (e as Error).message);
  }

  // Guarantee terminal state + record the on-chain hash (covers the case
  // where the mirror debit was skipped/failed above).
  await admin
    .from("wallet_txs")
    .update({ status: "done", arc_tx_hash: resolvedHash })
    .eq("id", walletTxId);

  return { ok: true, status: "done", arcTxHash: resolvedHash };
}
