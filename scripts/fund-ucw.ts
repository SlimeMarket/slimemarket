/**
 * One-off dev helper — fund the app's UCW with testnet USDC.
 *
 * The dev faucet draws from PLATFORM_CIRCLE_WALLET_ID (the treasury), which is
 * empty here, so faucet calls failed with "asset amount owned by the wallet is
 * insufficient". The user topped up their own Circle DCW from faucet.circle.com;
 * that wallet belongs to the same wallet set, so the app's own transfer helper
 * works with only the source wallet id changed.
 *
 * Run: npx tsx scripts/fund-ucw.ts [amountUsdc] [fromWalletId] [toAddress]
 */
import { sendUsdc } from "../lib/contracts/escrow-client";

const AMOUNT = Number(process.argv[2] ?? 5);
const FROM = process.argv[3] ?? "1c5359fa-20fc-5e28-99c8-dd98ce6ed040";
const TO = process.argv[4] ?? "0xf14215c294e2d08e34fb1f41973eb8a0942bec50";

async function main() {
  console.log(`transfer ${AMOUNT} USDC\n  from ${FROM}\n  to   ${TO}`);
  const micro = BigInt(Math.round(AMOUNT * 1_000_000));
  const res = await sendUsdc(FROM, TO, micro);
  console.log("result:", JSON.stringify(res));
  if (!res.id) {
    console.error("transfer failed — Circle did not return a transaction id");
    process.exit(1);
  }
  console.log("OK — check UCW balance at /api/wallet (onChainBalance) after a few seconds");
}

main().catch((e) => {
  console.error("failed:", e?.response?.data ?? e?.message ?? e);
  process.exit(1);
});
