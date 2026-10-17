/**
 * GET /api/wallet/gateway/constants
 * Public endpoint — returns Gateway contract addresses + minimal ABIs
 * so the frontend can build client-side transactions for external wallets.
 */
import { jsonOk } from "@/lib/utils";
import { ARC_CHAIN_ID, ARC_RPC_URL, ARC_USDC_CONTRACT } from "@/lib/arc";

export const dynamic = "force-dynamic";

// Gateway contracts are stable Circle deployments (testnet); escrow + RPC come
// from env so a redeploy never leaves a stale address baked into this route.
// chainId/rpcUrl MUST follow ARC_CHAIN_ID too: this endpoint is what a client
// would use to build EOA transactions, and returning 5042002 while the server
// is on mainnet is how a checkout ends up targeting the wrong network.
export async function GET() {
  return jsonOk({
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    usdc: {
      arcTestnet: ARC_USDC_CONTRACT,
    },
    escrow: process.env.ESCROW_CONTRACT_ADDRESS || null,
    selectors: {
      approve: "0x095ea7b3",
      deposit: "0x47e7ef24",
      initiateWithdrawal: "0xc8393ba9",
      withdraw: "0x51cff8d9",
    },
    chainId: ARC_CHAIN_ID,
    rpcUrl: ARC_RPC_URL,
  });
}
