/**
 * Query Circle transactions for a wallet to find USDC token ID
 *
 * Usage:
 *   node --env-file=.env.mainnet --import tsx scripts/query-wallet-txs.ts
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const walletId = process.env.PLATFORM_CIRCLE_WALLET_ID;

if (!apiKey || !entitySecret || !walletId) {
  console.error("Missing env vars");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

async function main() {
  console.log("=== Querying wallet transactions ===\n");

  try {
    const res = await client.listTransactions({ walletIds: [walletId] });
    const txs = res.data?.transactions || [];
    console.log(`Found ${txs.length} transactions`);

    for (const tx of txs) {
      console.log("\nTx:", JSON.stringify(tx, null, 2));
    }

    if (txs.length === 0) {
      console.log("\nNo transactions found. The 0.1 USDC might be on-chain but not yet indexed by Circle.");
    }
  } catch (e: any) {
    console.error("Query failed:", e.message);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
