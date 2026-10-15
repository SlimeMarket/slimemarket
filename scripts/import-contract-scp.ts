/**
 * Import MarketEscrow contract to Circle Smart Contract Platform.
 * 
 * This makes the contract visible in Circle Console → Smart Contracts,
 * and enables SCP query + event monitoring via API.
 * 
 * Usage:
 *   npx tsx --env-file=.env.local scripts/import-contract-scp.ts
 */
import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";

const ESCROW_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS;
const API_KEY = process.env.CIRCLE_API_KEY;
const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;

if (!ESCROW_ADDRESS || !API_KEY || !ENTITY_SECRET) {
  console.error("ERROR: Missing required env vars:");
  console.error("  ESCROW_CONTRACT_ADDRESS:", ESCROW_ADDRESS ? "✓" : "✗");
  console.error("  CIRCLE_API_KEY:", API_KEY ? "✓" : "✗");
  console.error("  CIRCLE_ENTITY_SECRET:", ENTITY_SECRET ? "✓" : "✗");
  process.exit(1);
}

async function main() {
  // Re-guard inside main(): module-level process.exit() does not narrow types
  // across the function boundary.
  if (!ESCROW_ADDRESS || !API_KEY || !ENTITY_SECRET) {
    throw new Error("Missing required env vars (checked at module level too)");
  }

  console.log("=== Import MarketEscrow to Circle SCP ===");
  console.log("  Contract:", ESCROW_ADDRESS);
  console.log("  Blockchain:", process.env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET");
  console.log("");

  const scp = initiateSmartContractPlatformClient({
    apiKey: API_KEY,
    entitySecret: ENTITY_SECRET,
  });

  try {
    // NOTE: do NOT send `description`. Circle's import endpoint rejects it with
    // the opaque "API parameter invalid" — verified live 2026-09-26 by probing
    // four payload shapes: with description (incl. an em dash) FAILED, without
    // description OK. `name` may contain spaces; only `description` is the
    // problem, so we simply omit it (it is cosmetic).
    const response = await scp.importContract({
      name: "MarketEscrow",
      address: ESCROW_ADDRESS,
      blockchain: (process.env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET") as any,
    });

    console.log("✓ Contract imported successfully!");
    console.log("  Contract ID:", response.data?.contract?.id);
    console.log("  Address:", response.data?.contract?.contractAddress);
    console.log("  Status:", response.data?.contract?.status);
    console.log("");
    console.log("View in Circle Console: https://console.circle.com/smart-contracts/contracts");
  } catch (error: any) {
    console.error("✗ Import failed:", error.message || error);
    
    // Check if already imported
    if (error.message?.includes("already") || error.message?.includes("exists")) {
      console.log("  Contract may already be imported. Check Circle Console.");
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Failed:", e.message || e);
  process.exit(1);
});
