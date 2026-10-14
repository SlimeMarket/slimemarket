/**
 * Gateway EOA Wallet Management
 * Adapted from circlefin/arc-multichain-wallet/lib/circle/create-gateway-eoa-wallets.ts
 *
 * Creates and manages EOA (Externally Owned Account) wallets for Gateway signing.
 * These wallets sign burn intents for cross-chain transfers.
 *
 * @license Apache-2.0
 */

import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { circleDeveloperSdk } from "@/lib/circle/client";

export interface GatewayEOAWallet {
  chain: string;
  address: string;
  walletId: string;
  name: string;
}

/**
 * Create a single multichain EOA wallet using Circle Wallets SDK.
 * Creates one EOA wallet that works across all EVM chains.
 * Circle SDK automatically derives the same address across all chains.
 */
export async function generateGatewayEOAWallet(
  walletSetId: string
): Promise<GatewayEOAWallet> {
  if (!circleDeveloperSdk) {
    throw new Error("Circle SDK not initialized. Check CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET.");
  }

  // Create EOA wallet on ALL supported chains so Circle SDK recognizes it everywhere
  const response = await circleDeveloperSdk.createWallets({
    walletSetId,
    accountType: "EOA",
    blockchains: ["ARC-TESTNET", "BASE-SEPOLIA", "AVAX-FUJI"],
    count: 1,
  });

  if (!response.data?.wallets || response.data.wallets.length === 0) {
    throw new Error("Failed to create Gateway EOA wallet via Circle SDK");
  }

  const wallet = response.data.wallets[0];
  console.log(`Created Gateway EOA wallet ${wallet.address} via Circle SDK`);

  return {
    chain: wallet.blockchain,
    address: wallet.address,
    walletId: wallet.id,
    name: wallet.name || "Gateway Signer (Multichain)",
  };
}

/**
 * Create wallet set and Gateway EOA wallet for a user.
 * Creates one multichain EOA wallet that can sign for all chains.
 */
export async function storeGatewayEOAWalletForUser(
  userId: string,
  walletSetId: string
) {
  const supabase = supabaseAdminClient();

  // Create one EOA wallet in the wallet set
  const wallet = await generateGatewayEOAWallet(walletSetId);

  // Store wallet information in database - one record for the multichain wallet.
  //
  // BUG FIX: this payload carried five columns that do not exist on `wallets`
  // (`name`, `wallet_address`, `blockchain`, `type`, `wallet_set_id`). PostgREST
  // rejects an insert with unknown columns, so this threw on EVERY call and the
  // Gateway signer could never be persisted. Only the real columns are written;
  // the multichain nature is expressed by `wallet_type`, and the wallet set id
  // lives in config (CIRCLE_WALLET_SET_ID) rather than per row.
  const insertData = {
    user_id: userId,
    address: wallet.address,
    wallet_type: "gateway_signer",
    circle_wallet_id: wallet.walletId,
  };

  const { data, error } = await supabase
    .from("wallets")
    .insert([insertData])
    .select();

  if (error) {
    console.error("Error storing Gateway EOA wallet:", error);
    throw error;
  }

  console.log(
    `Stored Gateway EOA wallet for user ${userId} with address ${wallet.address}`
  );
  return data;
}

/**
 * Get Gateway EOA wallet ID for a user (works for all blockchains).
 * Returns the Circle wallet ID which can be used with Circle SDK for transactions.
 */
export async function getGatewayEOAWalletId(
  userId: string,
  blockchain: string
): Promise<{ walletId: string; address: string }> {
  const supabase = supabaseAdminClient();

  // Get the multichain EOA wallet (wallet_type = "gateway_signer").
  // BUG FIX: filtered on `type`, which does not exist on `wallets` — the column
  // is `wallet_type`. PostgREST errored on every lookup, so the Gateway signer
  // was never found and all four /api/wallet/gateway/* routes failed.
  const { data, error } = await supabase
    .from("wallets")
    .select("circle_wallet_id, address")
    .eq("user_id", userId)
    .eq("wallet_type", "gateway_signer")
    .maybeSingle();

  if (error) {
    console.error("Error fetching Gateway EOA wallet:", error);
    throw error;
  }

  if (!data) {
    throw new Error(`Gateway EOA wallet not found for user ${userId}`);
  }

  return {
    walletId: data.circle_wallet_id,
    address: data.address,
  };
}

/**
 * Get or create the Gateway EOA wallet for a user.
 *
 * BUG FIX: this used to read `wallets.wallet_set_id` from the user's "SCA"
 * wallet. Neither exists — `wallets` has no `wallet_set_id` column, and the
 * filter used `type` instead of `wallet_type`. The wallet set id is deployment
 * config (CIRCLE_WALLET_SET_ID), not per-user state, so it is read from env.
 *
 * Also narrowed the catch: it used to swallow EVERY error and report "wallet
 * doesn't exist", which turned a broken query into a silent create attempt —
 * exactly how the two schema bugs above stayed hidden.
 */
export async function getOrCreateGatewayEOAWallet(
  userId: string,
  blockchain: string
): Promise<{ walletId: string; address: string }> {
  // Existing wallet → reuse it.
  try {
    return await getGatewayEOAWalletId(userId, blockchain);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Only a genuine "no such wallet" should fall through to creation. A DB or
    // config error must surface, not silently spawn a second wallet.
    if (!/not found for user/i.test(msg)) throw e;
  }

  console.log(`Creating Gateway EOA wallet for user ${userId}`);

  const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (!walletSetId) {
    throw new Error(
      "CIRCLE_WALLET_SET_ID is not set — cannot create a Gateway EOA wallet",
    );
  }

  await storeGatewayEOAWalletForUser(userId, walletSetId);
  return await getGatewayEOAWalletId(userId, blockchain);
}
