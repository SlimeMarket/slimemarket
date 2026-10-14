/**
 * Generate a deployer EOA wallet for contract deployment.
 * 
 * - Creates a random private key
 * - Saves to .secrets/deployer.key (gitignored)
 * - Prints the address to fund
 * - Optionally funds from platform DCW via Circle SDK
 * 
 * Usage: node scripts/generate-deployer.mjs
 *        node scripts/generate-deployer.mjs --fund 5
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from "viem";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SECRETS_DIR = resolve(ROOT, ".secrets");
const KEY_FILE = resolve(SECRETS_DIR, "deployer.key");
const ENV_FILE = resolve(ROOT, ".env.local");

// Parse .env.local
function loadEnv() {
  const raw = readFileSync(ENV_FILE, "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

async function main() {
  const args = process.argv.slice(2);
  const fundAmount = args.includes("--fund") ? args[args.indexOf("--fund") + 1] || "2" : null;

  // Check if deployer key already exists
  if (existsSync(KEY_FILE)) {
    const existingKey = readFileSync(KEY_FILE, "utf8").trim();
    const account = privateKeyToAccount(existingKey);
    console.log("Deployer wallet already exists:");
    console.log("  Address:", account.address);
    console.log("  Key file:", KEY_FILE);
    
    if (!fundAmount) {
      console.log("\nTo fund it: node scripts/generate-deployer.mjs --fund 2");
    }
  } else {
    // Generate new key
    mkdirSync(SECRETS_DIR, { recursive: true });
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    
    writeFileSync(KEY_FILE, privateKey, { mode: 0o600 });
    
    console.log("Deployer wallet generated:");
    console.log("  Address:", account.address);
    console.log("  Key file:", KEY_FILE);
    console.log("\n  IMPORTANT: This key is for deploying the contract ONCE.");
    console.log("  Keep it offline after deploy. Never commit to git.");
  }

  // Fund deployer from platform DCW
  if (fundAmount) {
    const env = loadEnv();
    const apiKey = env.CIRCLE_API_KEY;
    const entitySecret = env.CIRCLE_ENTITY_SECRET;
    const platformWalletId = env.PLATFORM_CIRCLE_WALLET_ID;
    const usdcTokenId = env.CIRCLE_USDC_TOKEN_ID || "15dc2b5d-0994-58b0-bf8c-3a0501148ee8";

    if (!apiKey || !entitySecret || !platformWalletId) {
      console.error("\nERROR: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, PLATFORM_CIRCLE_WALLET_ID required in .env.local");
      process.exit(1);
    }

    const deployerKey = readFileSync(KEY_FILE, "utf8").trim();
    const deployerAccount = privateKeyToAccount(deployerKey);

    console.log(`\nFunding deployer ${deployerAccount.address} with ${fundAmount} USDC from platform DCW...`);

    // Use Circle SDK to transfer from platform wallet to deployer
    const { initiateDeveloperControlledWalletsClient } = await import("@circle-fin/developer-controlled-wallets");
    const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

    try {
      const resp = await client.createTransaction({
        walletId: platformWalletId,
        tokenId: usdcTokenId,
        amount: [fundAmount],
        destinationAddress: deployerAccount.address,
        fee: { type: "level", config: { feeLevel: "LOW" } },
      });

      console.log("Transfer initiated:");
      console.log("  TX ID:", resp.data?.id || "pending");
      console.log("  State:", resp.data?.state || "QUEUED");
      console.log("\n  Wait ~30s for confirmation, then deploy.");
      console.log("  Check balance: node scripts/generate-deployer.mjs --balance");
    } catch (e) {
      console.error("Fund transfer failed:", e.message || e);
      process.exit(1);
    }
  }

  // Check balance
  if (args.includes("--balance")) {
    const env = loadEnv();
    const rpcUrl = env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
    const deployerKey = readFileSync(KEY_FILE, "utf8").trim();
    const deployerAccount = privateKeyToAccount(deployerKey);

    const publicClient = createPublicClient({
      transport: http(rpcUrl),
    });

    // USDC is native on Arc (18 decimals for native, 6 for ERC20 wrapper)
    // Check native balance
    const balance = await publicClient.getBalance({ address: deployerAccount.address });
    console.log(`\nDeployer balance (native): ${formatUnits(balance, 18)} USDC`);

    // Also check ERC20 USDC balance
    const usdcContract = env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS || "0x3600000000000000000000000000000000000000";
    try {
      const erc20Balance = await publicClient.readContract({
        address: usdcContract,
        abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
        functionName: "balanceOf",
        args: [deployerAccount.address],
      });
      console.log(`Deployer balance (ERC20 USDC): ${formatUnits(erc20Balance, 6)} USDC`);
    } catch {
      console.log("(ERC20 balance check failed — might not be available on this network)");
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
