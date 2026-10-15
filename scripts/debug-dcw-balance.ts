/**
 * Debug preflight DCW balance check
 */
import { createPublicClient, http, formatUnits, type Hex } from "viem";
import { ARC_USDC_CONTRACT } from "@/lib/arc";

const RPC = "https://rpc.mainnet.arc.io";
const erc20Abi = [
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

async function main() {
  const client = createPublicClient({ transport: http(RPC) });

  const dcw =
    process.env.PLATFORM_DCW_ADDRESS ??
    process.env.TREASURY_ADDRESS ??
    (process.env.TREASURY_WALLET_ID?.startsWith("0x") ? process.env.TREASURY_WALLET_ID : undefined);

  console.log("PLATFORM_DCW_ADDRESS:", process.env.PLATFORM_DCW_ADDRESS);
  console.log("TREASURY_ADDRESS:", process.env.TREASURY_ADDRESS);
  console.log("TREASURY_WALLET_ID:", process.env.TREASURY_WALLET_ID);
  console.log("Resolved dcw:", dcw);
  console.log("ARC_USDC_CONTRACT:", ARC_USDC_CONTRACT);

  if (!dcw) {
    console.log("DCW undefined!");
    return;
  }

  try {
    const bal = await client.readContract({
      address: ARC_USDC_CONTRACT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [dcw as Hex],
    });
    console.log("Raw balance:", bal.toString());
    console.log("Formatted (6):", formatUnits(bal as bigint, 6));
    console.log("Formatted (18):", formatUnits(bal as bigint, 18));
  } catch (e: any) {
    console.error("Error:", e.message);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
