/**
 * Create mainnet wallet set + SCA wallet for SlimeMarket.
 *
 * Usage:
 *   node --env-file=.env.mainnet --import tsx scripts/create-mainnet-wallet.ts
 *
 * This creates:
 *   1. A new wallet set on Circle (mainnet)
 *   2. A single SCA wallet inside it on Arc mainnet
 *
 * Output: walletSetId, walletId, walletAddress
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey || !entitySecret) {
  console.error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in env");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey,
  entitySecret,
});

async function main() {
  console.log("=== Creating mainnet wallet set + SCA wallet ===\n");

  // 1. Create wallet set
  console.log("Creating wallet set...");
  const wsRes = await client.createWalletSet({
    name: "SlimeMarket Mainnet",
  });

  const walletSet = wsRes.data?.walletSet;
  if (!walletSet?.id) {
    throw new Error("Wallet set creation failed: no ID returned");
  }
  console.log("  Wallet Set ID:", walletSet.id);

  // 2. Create SCA wallet inside the set
  console.log("Creating SCA wallet on Arc mainnet...");
  const wRes = await client.createWallets({
    walletSetId: walletSet.id,
    blockchains: ["ARC"],        // MAINNET — not ARC-TESTNET
    count: 1,
    accountType: "SCA",          // Smart Contract Account
  });

  const wallets = wRes.data?.wallets;
  if (!wallets || wallets.length === 0) {
    throw new Error("Wallet creation failed: no wallet returned");
  }

  const w = wallets[0];
  console.log("  Wallet ID:     ", w.id);
  console.log("  Wallet Address:", w.address);
  console.log("  Blockchain:    ", w.blockchain);

  console.log("\n=== DONE ===");
  console.log("\nPaste these into .env.mainnet:");
  console.log(`CIRCLE_WALLET_SET_ID=${walletSet.id}`);
  console.log(`PLATFORM_CIRCLE_WALLET_ID=${w.id}`);
  console.log(`NEXT_PUBLIC_AGENT_WALLET_ID=${w.id}`);
  console.log(`NEXT_PUBLIC_AGENT_WALLET_ADDRESS=${w.address}`);
  console.log(`TREASURY_WALLET_ID=${w.address}`);
}

main().catch((err) => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
