import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { CurrentUser } from "@/lib/auth-ucw";
import {
  CCTP_SOURCE_CHAINS,
  CCTP_TOKEN_MESSENGER_V2,
  cctpSourceChain,
  type CctpSourceChain,
} from "./chains";
import {
  createApproveChallenge,
  createBurnChallenge,
  formatUsdcAmount,
  readSourceBalances,
  verifySourceTx,
} from "./burn";
import { notifyUser } from "@/lib/notif";
import { crossChainPayEnabled, sourceChainWallets, ensureSourceChainWallets } from "./wallets";
import { fetchAttestation } from "./attestation";
import { relayMint } from "./relay";

/**
 * Orchestration for a CCTP bridge into Arc.
 *
 * The flow is deliberately split across several HTTP calls, because the user has
 * to approve two separate PIN challenges and the attestation in between takes
 * ~15 minutes:
 *
 *   POST prepare  -> row (PREPARED) + approve challenge
 *   POST confirm  -> verify approve on-chain -> (APPROVED) + burn challenge
 *   POST confirm  -> verify burn on-chain    -> (BURNED)
 *   relay         -> attestation -> receiveMessage on Arc -> (MINTED)
 *
 * The row is written BEFORE any signature is requested. That ordering matters:
 * if we only recorded the bridge after the burn, a user who closed the tab
 * between the two challenges would have USDC burned with no record on our side
 * and nothing pointing at the attestation that can still deliver it.
 */

export type BridgeStatus =
  | "PREPARED"
  | "APPROVED"
  | "BURNED"
  | "ATTESTED"
  | "MINTED"
  | "FAILED";

export interface BridgeView {
  id: string;
  sourceChain: string;
  sourceChainLabel: string;
  amountMicro: string;
  arcRecipient: string;
  status: BridgeStatus;
  approveTxHash: string | null;
  burnTxHash: string | null;
  mintTxHash: string | null;
  createdAt: string;
}

/**
 * The bridge columns the UI needs, written out IN FULL at each `.select()`.
 *
 * Deliberately not factored into a shared const or a template literal:
 * `scripts/check-select-columns.mjs` validates every `.select()` against a
 * dumped schema, and it cannot resolve either. A `${CONST}` select shows up as
 * `has no column "${CONST}"` — a false positive that makes the checker noisy,
 * and a noisy checker gets ignored, which is how the real findings get missed.
 * Duplicating a column list is the cheaper trade.
 */

interface BridgeRow {
  id: string;
  source_chain: string;
  amount_micro: string | number;
  arc_recipient: string;
  status: BridgeStatus;
  approve_tx_hash: string | null;
  burn_tx_hash: string | null;
  mint_tx_hash: string | null;
  created_at: string;
}

function toView(row: BridgeRow): BridgeView {
  return {
    id: row.id,
    sourceChain: row.source_chain,
    sourceChainLabel: cctpSourceChain(row.source_chain)?.label ?? row.source_chain,
    amountMicro: String(row.amount_micro),
    arcRecipient: row.arc_recipient,
    status: row.status,
    approveTxHash: row.approve_tx_hash,
    burnTxHash: row.burn_tx_hash,
    mintTxHash: row.mint_tx_hash,
    createdAt: row.created_at,
  };
}

/** A failure the caller should show the user verbatim (already human-readable). */
export class BridgeError extends Error {
  constructor(
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeOverview {
  enabled: boolean;
  /** CCTP domain of Arc, for display/debug. */
  arcDomain: number;
  arcRecipient: string | null;
  chains: Array<{
    key: string;
    label: string;
    standardOnly: boolean;
    address: string | null;
    live: boolean;
    /** Source-chain native gas symbol (ETH / AVAX). */
    nativeSymbol: string;
  }>;
  /** Set when the user has no wallet yet on one or more source chains. */
  provisionChallenge: { challengeId: string; chains: string[] } | null;
  bridges: BridgeView[];
}

/**
 * Everything the wallet page needs in one call: whether the feature is on, which
 * chains the user can bridge from, and their recent bridges.
 *
 * Provisioning is triggered lazily here rather than at signup: most users never
 * touch a source chain, and creating four extra wallets for every account would
 * be pure surface area for nothing.
 */
export async function getBridgeOverview(
  user: CurrentUser,
  creds: { userToken: string } | null,
): Promise<BridgeOverview> {
  const enabled = crossChainPayEnabled();
  const admin = supabaseAdminClient();

  const { data: rows } = await admin
    .from("cross_chain_bridges")
    .select("id, source_chain, amount_micro, arc_recipient, status, approve_tx_hash, burn_tx_hash, mint_tx_hash, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  const base: BridgeOverview = {
    enabled,
    arcDomain: 26,
    arcRecipient: user.walletAddress,
    chains: [],
    provisionChallenge: null,
    bridges: (rows ?? []).map((r) => toView(r as BridgeRow)),
  };

  if (!enabled || !creds?.userToken) return base;

  const ensured = await ensureSourceChainWallets(creds.userToken);
  const wallets = sourceChainWallets(ensured.wallets);
  const byKey = new Map(wallets.map((w) => [w.key, w]));

  base.chains = Object.entries(CCTP_SOURCE_CHAINS).map(([key, chain]) => ({
    key,
    label: chain.label,
    standardOnly: chain.standardOnly,
    address: byKey.get(key)?.address ?? null,
    live: byKey.get(key)?.live ?? false,
    nativeSymbol: chain.nativeSymbol,
  }));

  if (ensured.challengeId) {
    base.provisionChallenge = { challengeId: ensured.challengeId, chains: ensured.missing };
  }
  return base;
}

export interface StartResult {
  bridgeId: string;
  /** Which challenge to run next. */
  step: "approve" | "burn";
  challengeId: string;
  /** True when an existing allowance let us skip the approve transaction. */
  allowanceReused: boolean;
}

/**
 * Begin a bridge: validate everything we can BEFORE the user signs anything, so
 * a missing-gas or insufficient-balance problem surfaces as a clear message
 * rather than a revert halfway through.
 */
export async function startBridge(params: {
  user: CurrentUser;
  userToken: string;
  sourceChainKey: string;
  amountMicro: bigint;
}): Promise<StartResult> {
  const { user, userToken, sourceChainKey, amountMicro } = params;

  if (!crossChainPayEnabled()) {
    throw new BridgeError("Cross-chain payments are not enabled", 404);
  }
  if (amountMicro <= 0n) throw new BridgeError("Amount must be greater than 0");

  const chain = cctpSourceChain(sourceChainKey);
  if (!chain) throw new BridgeError(`Unsupported source chain: ${sourceChainKey}`);

  const arcRecipient = user.walletAddress;
  if (!arcRecipient) {
    throw new BridgeError(
      "Your Arc wallet is not set up yet — set your PIN first, then try again",
      409,
    );
  }

  // Find (or provision) the wallet on the source chain.
  const ensured = await ensureSourceChainWallets(userToken);
  const wallet = sourceChainWallets(ensured.wallets).find((w) => w.key === chain.key);
  if (!wallet) {
    throw new BridgeError(
      `You do not have a wallet on ${chain.label} yet. Open this page again to create one.`,
      409,
    );
  }
  if (!wallet.live) {
    throw new BridgeError(
      `Your ${chain.label} wallet is still being created — try again in a moment`,
      409,
    );
  }
  if (ensured.challengeId) {
    throw new BridgeError(
      `Create your ${chain.label} wallet first (a confirmation is waiting in your wallet)`,
      409,
    );
  }

  // The Circle wallet id is what the challenge is built against; the address is
  // what we verify the resulting transactions against. Keep both.
  const circleWalletId = walletIdFor(ensured.wallets, chain);

  // Preflight on-chain, so we fail with a useful message instead of a revert.
  const balances = await readSourceBalances(chain, wallet.address as `0x${string}`, amountMicro);
  if (balances.usdc < amountMicro) {
    throw new BridgeError(
      `Not enough USDC on ${chain.label}. You have ${balances.usdc.toString()} and tried to bridge ${amountMicro.toString()} (atomic units).`,
    );
  }
  if (!balances.hasGas) {
    throw new BridgeError(
      `Your ${chain.label} wallet has no ${chain.nativeSymbol} for gas. Send a small amount of ${chain.nativeSymbol} to ${wallet.address} first — the bridge needs it for two transactions.`,
    );
  }

  // Write the intent BEFORE asking for a signature.
  const admin = supabaseAdminClient();
  const { data: inserted, error } = await admin
    .from("cross_chain_bridges")
    .insert({
      user_id: user.id,
      source_chain: chain.key,
      source_wallet_id: circleWalletId,
      source_address: wallet.address,
      amount_micro: amountMicro.toString(),
      arc_recipient: arcRecipient,
      arc_domain: 26,
      status: "PREPARED",
    })
    .select("id")
    .single();

  if (error || !inserted) {
    throw new BridgeError("Could not record the bridge — please try again", 500);
  }
  const bridgeId = inserted.id as string;

  try {
    const reuse = balances.allowanceSufficient;
    const challenge = reuse
      ? await createBurnChallenge({
          userToken,
          walletId: circleWalletId,
          chain,
          amountMicro,
          arcRecipient,
          arcDomain: 26,
        })
      : await createApproveChallenge({ userToken, walletId: circleWalletId, chain, amountMicro });

    return {
      bridgeId,
      step: reuse ? "burn" : "approve",
      challengeId: challenge.challengeId,
      allowanceReused: reuse,
    };
  } catch (e) {
    // The row exists but nothing was signed. Mark it so it does not sit in
    // PREPARED forever looking like a stuck bridge.
    await admin
      .from("cross_chain_bridges")
      .update({ status: "FAILED", error: e instanceof Error ? e.message : "challenge failed" })
      .eq("id", bridgeId);
    throw e;
  }
}

function walletIdFor(
  wallets: Array<{ id: string; blockchain: string }>,
  chain: CctpSourceChain,
): string {
  const match = wallets.find((w) => w.blockchain?.toUpperCase() === chain.circleBlockchain);
  if (!match) {
    throw new BridgeError(`No Circle wallet found for ${chain.label}`, 409);
  }
  return match.id;
}

export interface ConfirmResult {
  status: BridgeStatus;
  /** Present when the next step needs another signature. */
  step?: "approve" | "burn";
  challengeId?: string;
  /** True when the burn is confirmed and we are now waiting on Circle's attestation. */
  awaitingAttestation?: boolean;
}

/**
 * Advance the bridge by one verified step.
 *
 * The tx hash comes from the browser, so it is checked on-chain first. A caller
 * cannot mark their bridge APPROVED/BURNED by inventing a hash.
 */
export async function confirmBridgeStep(params: {
  user: CurrentUser;
  userToken: string;
  bridgeId: string;
  step: "approve" | "burn";
  txHash: string;
}): Promise<ConfirmResult> {
  const { user, userToken, bridgeId, step, txHash } = params;
  const admin = supabaseAdminClient();

  const { data: row, error } = await admin
    .from("cross_chain_bridges")
    .select("id, source_chain, amount_micro, arc_recipient, status, approve_tx_hash, burn_tx_hash, mint_tx_hash, created_at, source_wallet_id, source_address, arc_domain")
    .eq("id", bridgeId)
    .eq("user_id", user.id) // ownership is part of the query, not a later check
    .maybeSingle();

  if (error || !row) throw new BridgeError("Bridge not found", 404);

  const bridge = row as BridgeRow & {
    source_wallet_id: string;
    source_address: string;
    arc_domain: number;
  };
  const chain = cctpSourceChain(bridge.source_chain);
  if (!chain) throw new BridgeError("Bridge references an unsupported chain", 409);

  if (step === "approve") {
    if (bridge.status !== "PREPARED" && bridge.status !== "APPROVED") {
      throw new BridgeError(`Cannot approve a bridge in state ${bridge.status}`, 409);
    }
    const check = await verifySourceTx({
      chain,
      txHash,
      expectedFrom: bridge.source_address as `0x${string}`,
      expectedTo: chain.usdc,
    });
    if (!check.ok) throw new BridgeError(check.reason ?? "Approval transaction is not valid");

    await admin
      .from("cross_chain_bridges")
      .update({ approve_tx_hash: txHash, status: "APPROVED" })
      .eq("id", bridgeId);

    // The allowance is now on-chain; build the burn challenge. Re-reading the
    // allowance rather than assuming keeps this correct if the approve was for
    // a smaller amount than the burn needs.
    const amountMicro = BigInt(bridge.amount_micro);
    const balances = await readSourceBalances(
      chain,
      bridge.source_address as `0x${string}`,
      amountMicro,
    );
    if (!balances.allowanceSufficient) {
      throw new BridgeError(
        "The approval did not cover the full amount — start the bridge again",
        409,
      );
    }

    const challenge = await createBurnChallenge({
      userToken,
      walletId: bridge.source_wallet_id, // Circle wallet id
      chain,
      amountMicro,
      arcRecipient: bridge.arc_recipient,
      arcDomain: bridge.arc_domain,
    });
    return { status: "APPROVED", step: "burn", challengeId: challenge.challengeId };
  }

  // step === "burn"
  if (bridge.status !== "APPROVED" && bridge.status !== "PREPARED" && bridge.status !== "BURNED") {
    throw new BridgeError(`Cannot burn a bridge in state ${bridge.status}`, 409);
  }
  // Idempotent: a retried confirm for the same burn is not an error.
  if (bridge.burn_tx_hash && bridge.burn_tx_hash.toLowerCase() === txHash.toLowerCase()) {
    return { status: bridge.status, awaitingAttestation: bridge.status === "BURNED" };
  }

  // A burn targets the TokenMessenger (which then pulls USDC via transferFrom),
  // so `to` is the messenger — NOT the USDC contract. The approve step above is
  // the one that targets USDC.
  const check = await verifySourceTx({
    chain,
    txHash,
    expectedFrom: bridge.source_address as `0x${string}`,
    expectedTo: CCTP_TOKEN_MESSENGER_V2,
  });
  if (!check.ok) throw new BridgeError(check.reason ?? "Burn transaction is not valid");

  await markBurned(bridgeId, txHash, check.blockNumber);
  return { status: "BURNED", awaitingAttestation: true };
}

async function markBurned(bridgeId: string, txHash: string, blockNumber?: bigint) {
  const admin = supabaseAdminClient();
  await admin
    .from("cross_chain_bridges")
    .update({
      burn_tx_hash: txHash,
      burn_block: blockNumber !== undefined ? Number(blockNumber) : null,
      status: "BURNED",
      error: null,
    })
    .eq("id", bridgeId);
}

export interface RelaySummary {
  scanned: number;
  pending: number;
  relayed: number;
  minted: number;
  failed: number;
}

/**
 * Try to complete pending burns by submitting the attested message on Arc.
 *
 * Safe to run as often as you like: the mint is permissionless and can only
 * deliver the user's own funds to their own address, and `receiveMessage`
 * rejects a message that was already received.
 *
 * Never throws — a cron caller wants a summary, not a stack trace.
 */
export async function relayPendingBridges(limit = 25): Promise<RelaySummary> {
  const summary: RelaySummary = { scanned: 0, pending: 0, relayed: 0, minted: 0, failed: 0 };
  if (!crossChainPayEnabled()) return summary;

  const admin = supabaseAdminClient();
  const { data: rows } = await admin
    .from("cross_chain_bridges")
    .select("id, user_id, source_chain, burn_tx_hash, status")
    .in("status", ["BURNED", "ATTESTED"])
    .not("burn_tx_hash", "is", null)
    .order("burn_block", { ascending: true })
    .limit(limit);

  for (const row of rows ?? []) {
    summary.scanned++;
    const outcome = await relayOneBridge(row as RelayRow);
    if (outcome === "MINTED") {
      summary.relayed++;
      summary.minted++;
    } else if (outcome === "PENDING") {
      summary.pending++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}

interface RelayRow {
  id: string;
  user_id: string;
  source_chain: string;
  burn_tx_hash: string | null;
  status?: string;
}

export type RelayOutcome = "MINTED" | "PENDING" | "FAILED";

/**
 * Attestation + mint for ONE bridge. Shared by the cron sweep and the user-facing
 * retry, so both paths behave identically (including the notification).
 *
 * Never throws: callers aggregate outcomes.
 */
async function relayOneBridge(row: RelayRow): Promise<RelayOutcome> {
  const admin = supabaseAdminClient();

  const chain = cctpSourceChain(row.source_chain);
  if (!chain) {
    await failBridge(row.id, `Unknown source chain ${row.source_chain}`);
    return "FAILED";
  }
  if (!row.burn_tx_hash) {
    // Nothing was burned, so there is no message to attest — this bridge simply
    // never got that far. The caller decides how to present that.
    await failBridge(row.id, "No burn transaction was recorded");
    return "FAILED";
  }

  const att = await fetchAttestation(chain.cctpDomain, row.burn_tx_hash);
  if (att.status === "pending" || att.status === "not_found") {
    // Not a failure — standard transfers take ~15 min to attest.
    return "PENDING";
  }
  if (att.status === "error" || !att.message || !att.attestation) {
    await failBridge(row.id, att.error ?? "attestation failed");
    return "FAILED";
  }

  await admin
    .from("cross_chain_bridges")
    .update({ attestation: att.attestation, status: "ATTESTED" })
    .eq("id", row.id);

  const relay = await relayMint({ message: att.message, attestation: att.attestation });

  if (relay.ok) {
    await markMinted(row, relay.txId ?? null);
    return "MINTED";
  }

  if (relay.retryable) {
    // Leave it ATTESTED so the next tick picks it up; the attestation does not
    // expire and the funds are already the user's.
    return "PENDING";
  }

  // Non-retryable. "Already received" means the message was consumed — the
  // mint happened (possibly on an earlier attempt of ours), so this is success
  // from the user's point of view.
  if (/already/i.test(relay.reason ?? "")) {
    await markMinted(row, null);
    return "MINTED";
  }

  await failBridge(row.id, relay.reason ?? "relay failed");
  return "FAILED";
}

/**
 * Flip a bridge to MINTED and tell the user.
 *
 * The notification is why this is a function: without it the USDC just appears
 * in the wallet and the buyer has no idea the bridge finished — the burn is
 * visible on the source chain, so from their side the money had simply left.
 * `notifyUser` never throws and no-ops without SMTP config.
 */
async function markMinted(row: RelayRow, mintTxId: string | null) {
  const admin = supabaseAdminClient();
  await admin
    .from("cross_chain_bridges")
    .update({ status: "MINTED", mint_tx_hash: mintTxId, error: null })
    .eq("id", row.id);

  const chain = cctpSourceChain(row.source_chain);
  const amount = await bridgeAmountMicro(row.id);
  const amountText = amount !== null ? formatUsdcAmount(amount) + " USDC" : "Your USDC";

  // Record the credit in the wallet history.
  //
  // Without this the bridge was INVISIBLE in Transaction History: the mint is
  // an ERC-20 transfer executed by OUR relayer, so it never appears in Circle's
  // `listTransactions` for the user either — and nothing wrote a `wallet_txs`
  // row. The USDC simply appeared in the balance with no entry explaining it.
  await recordBridgeCredit({
    userId: row.user_id,
    bridgeId: row.id,
    chainLabel: chain?.label ?? row.source_chain,
    chainKey: row.source_chain,
    amountMicro: amount,
    mintTxId,
  });

  await notifyUser(row.user_id, {
    icon: "arrow-left-right",
    tone: "emerald",
    title: "Bridge complete",
    text: `${amountText} from ${chain?.label ?? row.source_chain} has arrived in your Slime Wallet on Arc.`,
    link: "balance",
    email: {
      subject: "Your USDC has arrived on Arc",
      body:
        `${amountText} bridged from ${chain?.label ?? row.source_chain} is now in your Arc wallet.\n\n` +
        `You can spend it straight away — place an order or open an escrow deal.\n`,
    },
  });
}

/**
 * Write the inbound `wallet_txs` row for a completed bridge.
 *
 * `method: "cctp"` — the value the `wallet_txs_method_check` constraint has
 * allowed since it was written, but which nothing had ever used. This is what
 * it was there for.
 *
 * IDEMPOTENT via `idempotency_key` (a UNIQUE index): `markMinted` can run twice
 * — the cron tick and a user-triggered retry can race — and the second insert
 * fails the unique constraint. That is success, not an error, so a duplicate is
 * swallowed deliberately.
 *
 * NEVER throws: a missing history row must not fail a mint that already
 * happened on-chain.
 */
async function recordBridgeCredit(params: {
  userId: string;
  bridgeId: string;
  chainLabel: string;
  chainKey: string;
  amountMicro: bigint | null;
  mintTxId: string | null;
}): Promise<void> {
  const { userId, bridgeId, chainLabel, chainKey, amountMicro, mintTxId } = params;
  if (amountMicro === null) return; // no amount to record — better silent than wrong

  try {
    const admin = supabaseAdminClient();
    // `wallet_txs.wallet_id` is the wallet ROW id, not the Circle wallet id.
    const { data: wallet } = await admin
      .from("wallets")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!wallet?.id) return;

    const { error } = await admin.from("wallet_txs").insert({
      wallet_id: wallet.id,
      type: "in",
      label: `Bridged from ${chainLabel}`,
      sub: "Cross-chain USDC (CCTP)",
      amount: amountMicro,
      status: "done",
      method: "cctp",
      arc_tx_hash: mintTxId,
      idempotency_key: `cctp-bridge:${bridgeId}`,
      metadata: { bridgeId, sourceChain: chainKey },
    });

    if (error && !/duplicate key/i.test(error.message)) {
      console.error("[cctp] failed to record wallet_tx:", error.message);
    }
  } catch (e) {
    console.error("[cctp] wallet_tx insert threw:", e instanceof Error ? e.message : String(e));
  }
}

async function bridgeAmountMicro(bridgeId: string): Promise<bigint | null> {
  try {
    const admin = supabaseAdminClient();
    const { data } = await admin
      .from("cross_chain_bridges")
      .select("amount_micro")
      .eq("id", bridgeId)
      .maybeSingle();
    return data?.amount_micro != null ? BigInt(String(data.amount_micro)) : null;
  } catch {
    return null; // display-only; never fail the mint over it
  }
}

export interface RetryResult {
  status: BridgeStatus;
  outcome: RelayOutcome;
  /** Human-readable, safe to show the user. */
  message: string;
}

/**
 * User-triggered retry for a bridge that is stuck.
 *
 * WHY THIS IS SAFE TO EXPOSE: the mint is permissionless and the amount and
 * recipient are fixed inside Circle's signed message — the user's own Arc
 * address. So a retry can only ever deliver funds that are already theirs, and
 * `receiveMessage` rejects a message that was already consumed.
 *
 * This exists because the cron alone leaves the user with no way to act: the
 * burn is visible on the source chain, so their USDC looks gone while the mint
 * waits on an attestation that can take ~15 minutes.
 */
export async function retryBridge(params: {
  userId: string;
  bridgeId: string;
}): Promise<RetryResult> {
  const { userId, bridgeId } = params;
  if (!crossChainPayEnabled()) {
    throw new BridgeError("Cross-chain payments are not enabled", 404);
  }

  const admin = supabaseAdminClient();
  const { data: row } = await admin
    .from("cross_chain_bridges")
    .select("id, user_id, source_chain, burn_tx_hash, status")
    .eq("id", bridgeId)
    .eq("user_id", userId) // ownership is part of the query, not a later check
    .maybeSingle();

  if (!row) throw new BridgeError("Bridge not found", 404);
  const bridge = row as RelayRow;

  if (bridge.status === "MINTED") {
    return { status: "MINTED", outcome: "MINTED", message: "This bridge has already been delivered." };
  }

  if (!bridge.burn_tx_hash) {
    // Nothing was burned, so there is nothing to re-attest. Sending them to a
    // fresh bridge is the only correct answer — retrying would look like it did
    // something while changing nothing.
    throw new BridgeError(
      "This bridge never reached the burn step, so there is nothing to retry — start a new bridge instead.",
      409,
    );
  }

  const outcome = await relayOneBridge(bridge);

  const { data: fresh } = await admin
    .from("cross_chain_bridges")
    .select("status")
    .eq("id", bridgeId)
    .maybeSingle();
  const status = (fresh?.status ?? bridge.status ?? "BURNED") as BridgeStatus;

  const message =
    outcome === "MINTED"
      ? "Delivered — your USDC is in your Arc wallet."
      : outcome === "PENDING"
        ? "Circle is still attesting the transfer. This usually takes about 15 minutes from the burn — try again shortly."
        : "The relay could not complete. Nothing is lost: the burn is on-chain and the attestation does not expire.";

  return { status, outcome, message };
}

async function failBridge(id: string, reason: string) {
  const admin = supabaseAdminClient();
  await admin
    .from("cross_chain_bridges")
    .update({ status: "FAILED", error: reason.slice(0, 500) })
    .eq("id", id);
}
