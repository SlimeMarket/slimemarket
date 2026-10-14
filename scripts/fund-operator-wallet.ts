/**
 * Fund Operator Wallet with Testnet USDC
 * Uses Circle Gateway for cross-chain transfers or testnet faucet
 */

import { createPublicClient, http, parseUnits } from 'viem';
import { exit } from 'process';

async function main() {
  console.log("=".repeat(70));
  console.log("💰 FUND OPERATOR WALLET - ARC TESTNET");
  console.log("=".repeat(70));
  
  // Load environment
  const arcRpc = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
  const usdcAddress = process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS || 
                     "0x3600000000000000000000000000000000000000";
  
  // From .secrets/server-wallet.json
  const operatorWalletAddress = "0xb5ce274c8bd4d46b376f2d27eb5c2c2406fe042d";
  
  console.log(`ARC RPC: ${arcRpc}`);
  console.log(`USDC Contract: ${usdcAddress}`);
  console.log(`Operator Wallet: ${operatorWalletAddress}`);
  console.log();
  
  // Check current balance
  try {
    const client = createPublicClient({
      transport: http(arcRpc)
    });
    
    const balance = await client.readContract({
      address: usdcAddress as `0x${string}`,
      abi: [{
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }]
      }],
      functionName: "balanceOf",
      args: [operatorWalletAddress as `0x${string}`]
    });
    
    const usdcBalance = Number(balance) / 1_000_000;
    console.log(`Current Balance: ${usdcBalance.toFixed(2)} USDC`);
    
    if (usdcBalance < 1) {
      console.log("\n⚠️  WARNING: Operator wallet has insufficient USDC!");
      console.log("\nTo fund it:");
      console.log("1. Get testnet USDC from faucet: https://portal.arc.network/");
      console.log("2. Transfer ~10-100 USDC to: " + operatorWalletAddress);
      console.log("\nOr use Circle Gateway if you have USDC on another chain.");
      exit(1);
    } else {
      console.log("\n✅ Operator wallet funded!");
    }
    
  } catch (error) {
    console.error("❌ Failed to check balance:", error);
    exit(1);
  }
}

main().catch(console.error);
