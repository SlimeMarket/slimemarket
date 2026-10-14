/**
 * Deploy MarketEscrow.sol to Arc Testnet (fee model: 2% buyer + 2% seller on marketplace orders).
 *
 * F6 deployment (simplified):
 *   1. Deploy MarketEscrow with treasury = platform DCW (skip MultisigTreasury)
 *   2. Update .env.local: ESCROW_CONTRACT_ADDRESS + TREASURY_WALLET_ID
 *      (both point to the same DCW wallet address)
 *
 * Prerequisites:
 *   - .secrets/deployer.key exists
 *   - Deployer funded with USDC for gas
 *   - NEXT_PUBLIC_AGENT_WALLET_ADDRESS configured (DCW wallet address that will be _treasury+_platform)
 *
 * Usage:
 *   node --env-file=.env.local --import tsx contracts/deploy.ts
 */
import { createWalletClient, createPublicClient, http, type Hex, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Load deployer key
const keyFile = resolve(ROOT, ".secrets/deployer.key");
let deployerKey: Hex;
try {
  deployerKey = readFileSync(keyFile, "utf8").trim() as Hex;
} catch {
  console.error("ERROR: .secrets/deployer.key not found. Run: node scripts/generate-deployer.mjs");
  process.exit(1);
}

// Load compiled contract
const escrowJson = JSON.parse(readFileSync(resolve(ROOT, "contracts/MarketEscrow.json"), "utf8"));

// Constructor params from env
const usdcContract = process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
const platformAddress = process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS;

if (!usdcContract || !platformAddress) {
  console.error("ERROR: NEXT_PUBLIC_USDC_CONTRACT_ADDRESS or NEXT_PUBLIC_AGENT_WALLET_ADDRESS not set");
  process.exit(1);
}

const ARC_RPC_URL =
  process.env.ARC_RPC_URL ??
  (process.env.ARC_CHAIN_ID === "5042" ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");
const ARC_CHAIN_ID = parseInt(process.env.ARC_CHAIN_ID ?? "5042002");
/** Drives both the viem chain name and the printed banner — a wrong label here
 *  has caused a mainnet deploy to be mistaken for a testnet one. */
const IS_MAINNET = ARC_CHAIN_ID === 5042;
const NETWORK_LABEL = IS_MAINNET ? "Arc Mainnet" : "Arc Testnet";

const arcChain = {
  id: ARC_CHAIN_ID,
  name: NETWORK_LABEL,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
};

async function main() {
  // Re-guard inside main(): module-level process.exit() does not narrow types
  // across the function boundary.
  if (!usdcContract || !platformAddress) {
    throw new Error("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS / NEXT_PUBLIC_AGENT_WALLET_ADDRESS not set");
  }
  const account = privateKeyToAccount(deployerKey);

  console.log("=== MarketEscrow Deployment (v4 Fee Model) ===");
  console.log(`  Network:    ${NETWORK_LABEL}${IS_MAINNET ? "  ⚠️  REAL MONEY" : ""} (chainId ${ARC_CHAIN_ID})`);
  console.log("  RPC:        ", ARC_RPC_URL);
  console.log("  Deployer:   ", account.address);
  console.log("  USDC:       ", usdcContract);
  console.log("  Treasury&Platform:", platformAddress);
  console.log("");

  const publicClient = createPublicClient({ transport: http(ARC_RPC_URL) });
  const walletClient = createWalletClient({ account, chain: arcChain, transport: http(ARC_RPC_URL) });

  // Check deployer balance
  const balance = await publicClient.getBalance({ address: account.address });
  console.log("  Deployer balance:", (Number(balance) / 1e18).toFixed(4), "USDC (native)");
  if (balance === 0n) {
    console.error("ERROR: Deployer has no balance. Fund it from https://faucet.circle.com");
    process.exit(1);
  }

  // -------- Step 1: Deploy MarketEscrow (treasury = platform = DCW wallet) --------
  console.log("\n--- Step 1: Deploy MarketEscrow ---");
  const escrowHash = await walletClient.deployContract({
    abi: escrowJson.abi,
    bytecode: escrowJson.bytecode as Hex,
    args: [usdcContract as Hex, platformAddress as Hex, platformAddress as Hex],
  });
  console.log("  TX:", escrowHash);
  const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowHash, timeout: 60_000 });
  if (escrowReceipt.status !== "success" || !escrowReceipt.contractAddress) {
    console.error("ERROR: MarketEscrow deploy failed");
    process.exit(1);
  }
  const escrowAddress = escrowReceipt.contractAddress;
  console.log("  ✓ MarketEscrow:", escrowAddress);
  console.log("    Block:", escrowReceipt.blockNumber, "Gas:", escrowReceipt.gasUsed.toString());

  // -------- Step 2: Add platform DCW as middleman BEFORE transferring ownership --------
  // .C FIX — ordering bug: addMiddleman() is onlyOwner, and once step 3
  // transfers ownership to the platform DCW, the deployer key can no longer
  // call it — the old placement failed silently inside try/catch, leaving
  // middlemen[platform]=false and breaking WL escrow release/refund
  // (onlyMiddleman) on every deploy since v4. Verified live 2026-08-22:
  // the deployed contract had middlemen[0x731f…] = 0x00.
  console.log("\n--- Step 2: addMiddleman(platform DCW) [while deployer still owner] ---");
  try {
    const addMMAbi = parseAbi(["function addMiddleman(address) external"]);
    const addMMHash = await walletClient.writeContract({
      address: escrowAddress as Hex,
      abi: addMMAbi,
      functionName: "addMiddleman",
      args: [platformAddress! as Hex],
      chain: arcChain,
      account,
    });
    console.log("  TX:", addMMHash);
    await publicClient.waitForTransactionReceipt({ hash: addMMHash, timeout: 60_000 });
    console.log("  ✓ Platform DCW added as middleman (can call releaseEscrow/refundEscrow)");
  } catch (e) {
    console.warn("WARNING: addMiddleman failed — platform may not have WL escrow permissions:", (e as Error).message);
  }

  // VERIFY, don't assume. The warn-and-continue above previously
  // masked a silent failure that left middlemen[platform]=false and broke every
  // WL release/refund (onlyMiddleman). Read the mapping back and abort the
  // deploy if the platform is not registered.
  {
    const mmAbi = parseAbi([
      "function middlemen(address) view returns (bool)",
    ]);
    const isMm = await publicClient.readContract({
      address: escrowAddress as Hex,
      abi: mmAbi,
      functionName: "middlemen",
      args: [platformAddress as Hex],
    });
    if (!isMm) {
      console.error(
        "\nFATAL: middlemen[platform] is still false after addMiddleman — WL (rekber) release/refund would revert on every deal.\n" +
          "Aborting before transferOwnership so the contract can be fixed (or redeployed) while the deployer is still owner.\n" +
          "Manual repair path: scripts/repair-middleman.ts",
      );
      process.exit(1);
    }
    console.log("  ✓ verified middlemen[platform] == true");
  }

  // -------- Step 3: transferOwnership to platform DCW wallet --------
  // After deploy, owner = deployer EOA. Transfer to platform DCW so all admin
  // functions require DCW signature. Platform DCW will also be the operator
  // (relayer) and treasury (fee collector).
  console.log("\n--- Step 3: transferOwnership(platform DCW) ---");
  const transferAbi = parseAbi(["function transferOwnership(address newOwner) external"]);
    const transferHash = await walletClient.writeContract({
      address: escrowAddress as Hex,
      abi: transferAbi,
      functionName: "transferOwnership",
      args: [platformAddress! as Hex],
      chain: arcChain,
      account,
    });
  console.log("  TX:", transferHash);
  const transferReceipt = await publicClient.waitForTransactionReceipt({ hash: transferHash, timeout: 60_000 });
  if (transferReceipt.status !== "success") {
    console.error("ERROR: transferOwnership failed — MarketEscrow owner stays as deployer. Fix manually.");
  } else {
    console.log("  ✓ MarketEscrow ownership transferred to platform DCW");
  }

  // -------- Step 4: Update .env.local --------
  console.log("\n--- Step 4: Update .env.local ---");
  const envFile = resolve(ROOT, ".env.local");
  let envContent = readFileSync(envFile, "utf8");
  const updates: Record<string, string> = {
    ESCROW_CONTRACT_ADDRESS: escrowAddress,
    TREASURY_WALLET_ID: platformAddress, // same as platform, since treasury=platform now
    // the indexer reads ESCROW_START_BLOCK to know where to start
    // scanning; it was previously left to be set by hand (and forgotten).
    ESCROW_START_BLOCK: String(escrowReceipt.blockNumber),
  };
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(envContent)) {
      envContent = envContent.replace(re, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}\n`;
    }
  }
  writeFileSync(envFile, envContent);
  console.log("  ✓ .env.local updated:");
  console.log("    ESCROW_CONTRACT_ADDRESS =", escrowAddress);
  console.log("    TREASURY_WALLET_ID      =", platformAddress);

  // -------- Summary --------
  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log("  MarketEscrow:      ", escrowAddress);
  console.log("  Owner (now):       ", platformAddress, "(platform DCW)");
  console.log("  Treasury:          ", platformAddress);
  console.log("  Platform (operator):", platformAddress);
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Restart dev server to pick up new env.");
  console.log("    2. Reset indexer_state row (new contract = new event stream):");
  console.log("       supabase db query --local \"delete from indexer_state;\"");
  console.log("    3. Null stale on_chain_order_id / on_chain_deal_id columns");
  console.log("       (legacy orders reference the OLD contract's uint ids).");
  console.log("    4. (Optional) Add other middlemen via addMiddleman(mmAddress)");
  console.log("    5. Verify: curl localhost:3000/api/health → contractReady=true, treasury=platform");
}

main().catch((e) => {
  console.error("Deploy failed:", e.message || e);
  process.exit(1);
});
