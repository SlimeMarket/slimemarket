import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { arcPublicClient } from "@/lib/arc";
import { validateDealActionTx, type WlDealAction } from "@/lib/wl/eoa";
import type { Hex } from "viem";

/**
 * Shared plumbing for the single-arg escrow lifecycle routes
 * (mark-delivered / confirm-receipt / dispute).
 *
 * THE SHAPE: the party broadcasts the contract call from their OWN wallet
 * (WalletBridge for an EOA, or a UCW challenge), then posts the tx hash here.
 * The route must not trust that hash — it re-reads the transaction from Arc and
 * proves it really is the expected call, by the expected sender, for this deal.
 * Only then does the DB transition run.
 *
 * Returns the verified sender address (lower-cased).
 */
export interface VerifiedDealAction {
  dealId: string;
  onChainDealId: string;
  sender: string;
}

export async function verifyDealActionTx(params: {
  dealId: string;
  actorId: string;
  txHash: string;
  action: WlDealAction;
}): Promise<VerifiedDealAction> {
  const { dealId, actorId, txHash: rawTxHash, action } = params;

  // A UCW `CONTRACT_EXECUTION` challenge settles with `data: null`, so the client
  // has no on-chain hash to send — only the Circle CHALLENGE id. Resolve the real
  // transaction (and its hash) here rather than making every caller talk to Circle.
  // An external-wallet caller still sends a 0x hash and skips this entirely.
  //
  // Note the endpoint shape: `/v1/w3s/transactions/{id}` expects the transaction
  // UUID and 404s ("Cannot find target transaction") for a challenge id. The
  // challenge→transaction lookup is the LIST endpoint with `?challengeId=`.
  let txHash = rawTxHash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    const apiKey = process.env.CIRCLE_API_KEY;
    if (!apiKey) throw new Error("CIRCLE_API_KEY not configured");
    const deadline = Date.now() + 60_000;
    let resolved: string | undefined;
    while (Date.now() < deadline) {
      const resp = await fetch(
        `https://api.circle.com/v1/w3s/transactions?challengeId=${encodeURIComponent(rawTxHash)}`,
        { headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` } },
      );
      const json = (await resp.json().catch(() => ({}))) as {
        data?: { transactions?: Array<{ state?: string; txHash?: string; errorDetails?: string }> };
      };
      const tx = json.data?.transactions?.[0];
      if (tx?.state === "FAILED" || tx?.state === "CANCELLED" || tx?.state === "DENIED") {
        throw new Error(`on-chain action ${tx.state.toLowerCase()}${tx.errorDetails ? `: ${tx.errorDetails}` : ""}`);
      }
      if (tx?.txHash) { resolved = tx.txHash; break; }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!resolved) throw new Error("could not resolve the on-chain transaction hash yet");
    txHash = resolved;
  }

  const escrowAddress = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
  if (!escrowAddress) throw new Error("escrow contract address not configured");

  const admin = supabaseAdminClient();
  const { data: deal } = await admin.from("wl_deals")
    .select("id, buyer_id, seller_id, status, on_chain_deal_id")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) throw new Error("deal not found");

  // Role guard first — cheapest rejection, and it mirrors the contract's
  // msg.sender requirement before we spend an RPC round-trip.
  const isBuyer = deal.buyer_id === actorId;
  const isSeller = deal.seller_id === actorId;
  if (action === "markDelivered" && !isSeller) throw new Error("mark delivered: seller only");
  if (action === "confirmEscrow" && !isBuyer) throw new Error("confirm: buyer only");
  if (action === "flagDispute" && !isBuyer && !isSeller) {
    throw new Error("dispute: buyer or seller only");
  }

  const onChainDealId = deal.on_chain_deal_id as string | null;
  // "0" IS a valid contract deal id (the first deal) — only null/empty means the
  // deal was never created on-chain.
  if (onChainDealId == null || onChainDealId === "") {
    throw new Error("deal not confirmed on-chain yet");
  }

  // The on-chain identity of each party: their UCW wallet row, or any external
  // wallet they linked (external_wallets). Anything else is rejected.
  const userIds = action === "flagDispute" ? [deal.buyer_id, deal.seller_id] : [actorId];
  const allowedSenders: string[] = [];
  for (const uid of userIds) {
    if (!uid) continue;
    const { data: wallet } = await admin.from("wallets")
      .select("address").eq("user_id", uid).maybeSingle();
    if (wallet?.address) allowedSenders.push(wallet.address as string);
    const { data: ext } = await admin.from("external_wallets")
      .select("address").eq("user_id", uid);
    for (const w of (ext ?? []) as { address: string }[]) allowedSenders.push(w.address);
  }
  if (allowedSenders.length === 0) throw new Error("party has no on-chain wallet");

  // Re-read the tx from Arc — never trust the client-supplied hash's meaning.
  const client = arcPublicClient();
  let receipt: { status: string; to: string; from: string };
  let tx: { to: string | null; from: string; input: string };
  try {
    [receipt, tx] = await Promise.all([
      client.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 60_000 }) as Promise<{ status: string; to: string; from: string }>,
      client.getTransaction({ hash: txHash as Hex }) as Promise<{ to: string | null; from: string; input: string }>,
    ]);
  } catch (e) {
    throw new Error(`${action} tx not found on Arc: ${(e as Error).message}`);
  }

  const sender = validateDealActionTx(
    {
      to: tx.to ?? receipt.to ?? "",
      status: receipt.status,
      sender: tx.from ?? receipt.from ?? "",
      input: tx.input ?? "0x",
    },
    { escrowAddress, allowedSenders, onChainDealId, action },
  );

  return { dealId, onChainDealId, sender };
}
