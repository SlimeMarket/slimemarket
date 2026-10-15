/**
 * Query Circle for wallet details (includes token balances & token IDs)
 *
 * Usage:
 *   node --env-file=.env.mainnet --import tsx scripts/query-wallet-details.ts
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const walletId = process.env.PLATFORM_CIRCLE_WALLET_ID;

if (!apiKey || !entitySecret || !walletId) {
  console.error("Missing CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, or PLATFORM_CIRCLE_WALLET_ID");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

async function main() {
  console.log("=== Querying wallet details ===\n");

  // 1. Get wallet info
  console.log("Wallet info:");
  try {
    const wRes = await client.getWallet({ id: walletId });
    console.log(JSON.stringify(wRes.data, null, 2));
  } catch (e: any) {
    console.error("Wallet query failed:", e.message);
  }

  // 2. Get wallet token balance
  console.log("\n=== Token balances ===");
  try {
    const bRes = await client.getWalletTokenBalance({ walletId });
    console.log(JSON.stringify(bRes.data, null, 2));
  } catch (e: any) {
    console.error("Balance query failed:", e.message);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
