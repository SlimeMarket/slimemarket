/**
 * Fund the Hardhat deployer EOA with native USDC from the platform DCW.
 *
 * Arc uses USDC as its gas token, so this single transfer gives the deployer
 * everything it needs to deploy MarketEscrow.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/fund-deployer.ts [address] [amount]
 *   node --env-file=.env.local --import tsx scripts/fund-deployer.ts --status <txId>
 *
 * NOTE on the SDK call shape: this version of
 * @circle-fin/developer-controlled-wallets expects `amount` (singular, array)
 * and a `fee: { type: "level", config: { feeLevel } }` object — NOT `amounts` /
 * `feeLevel`. Passing the wrong names throws the opaque
 * "Cannot read properties of undefined (reading 'config')".
 */
import { randomUUID } from "crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const API_KEY = process.env.CIRCLE_API_KEY;
const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
const WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID;
const TOKEN_ID =
  process.env.CIRCLE_USDC_TOKEN_ID ?? "15dc2b5d-0994-58b0-bf8c-3a0501148ee8";

const DEFAULT_DESTINATION = "0x069fB57E95c1B46AF2a4D6D3E7243E9e4195bb8D";

function client() {
  if (!API_KEY || !ENTITY_SECRET) {
    console.error("Missing env: CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET");
    process.exit(1);
  }
  return initiateDeveloperControlledWalletsClient({
    apiKey: API_KEY,
    entitySecret: ENTITY_SECRET,
  });
}

async function showStatus(id: string) {
  const res = await client().getTransaction({ id });
  const tx = res.data?.transaction;
  console.log("id    :", tx?.id);
  console.log("state :", tx?.state);
  console.log("txHash:", tx?.txHash);
  console.log("error :", tx?.errorReason ?? "none");
}

async function main() {
  if (!WALLET_ID) {
    console.error("Missing env: PLATFORM_CIRCLE_WALLET_ID");
    process.exit(1);
  }
  const destination = process.argv[2] ?? DEFAULT_DESTINATION;
  const amount = process.argv[3] ?? "1";

  console.log("=== Fund deployer from platform DCW ===");
  console.log("  from wallet :", WALLET_ID);
  console.log("  to          :", destination);
  console.log("  amount      :", amount, "USDC (native, 18 decimals)");
  console.log("  tokenId     :", TOKEN_ID);
  console.log("");

  const res = await client().createTransaction({
    idempotencyKey: randomUUID(),
    walletId: WALLET_ID,
    tokenId: TOKEN_ID,
    amount: [amount],
    destinationAddress: destination,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  console.log("OK — transfer submitted");
  console.log("  id    :", res.data?.id);
  console.log("  state :", res.data?.state);
  console.log("");
  console.log("Poll: node --env-file=.env.local --import tsx scripts/fund-deployer.ts --status", res.data?.id);
}

const args = process.argv.slice(2);
(args[0] === "--status" && args[1] ? showStatus(args[1]) : main()).catch((e) => {
  console.error("FAILED:", e?.response?.data ? JSON.stringify(e.response.data) : e.message || e);
  process.exit(1);
});
