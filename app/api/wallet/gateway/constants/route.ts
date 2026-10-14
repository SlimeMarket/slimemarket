/**
 * GET /api/wallet/gateway/constants
 * Public endpoint — returns Gateway contract addresses + minimal ABIs
 * so the frontend can build client-side transactions for external wallets.
 */
import { jsonOk } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Gateway contracts are stable Circle deployments (testnet); escrow + RPC come
// from env so a redeploy never leaves a stale address baked into this route.
export async function GET() {
  return jsonOk({
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    usdc: {
      arcTestnet: "0x3600000000000000000000000000000000000000",
    },
    escrow: process.env.ESCROW_CONTRACT_ADDRESS || null,
    selectors: {
      approve: "0x095ea7b3",
      deposit: "0x47e7ef24",
      initiateWithdrawal: "0xc8393ba9",
      withdraw: "0x51cff8d9",
    },
    chainId: 5042002,
    rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
  });
}
