/**
 * Check balances directly via Arc mainnet RPC
 *
 * Usage:
 *   node --env-file=.env.production --import tsx scripts/check-balances.ts
 */
import { createPublicClient, http, formatUnits } from "viem";

const RPC = "https://rpc.mainnet.arc.io";
const USDC = "0x3600000000000000000000000000000000000000";

const addresses = [
  { name: "Deployer", addr: "0x069fB57E95c1B46AF2a4D6D3E7243E9e4195bb8D" },
  { name: "Platform DCW (SCA)", addr: "0xf8e35844227d5a0d3713cdd50bf96812dbc671e7" },
  { name: "User wallet", addr: "0xd36583346c4fe00730419260aac490cfe286fee2" },
];

const erc20Abi = [
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

async function main() {
  const client = createPublicClient({ transport: http(RPC) });
  console.log("=== Arc Mainnet Balances ===\n");

  for (const { name, addr } of addresses) {
    try {
      // Native balance (USDC is native on Arc, but SCA wallets might not show this)
      const native = await client.getBalance({ address: addr as `0x${string}` });
      // USDC contract balance
      const usdc = await client.readContract({
        address: USDC as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [addr as `0x${string}`],
      });

      console.log(`${name} (${addr})`);
      console.log(`  Native: ${formatUnits(native, 18)} USDC`);
      console.log(`  ERC20:  ${formatUnits(usdc, 6)} USDC`);
      console.log("");
    } catch (e: any) {
      console.log(`${name}: ERROR — ${e.message}\n`);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
