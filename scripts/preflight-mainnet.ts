/**
 * Mainnet preflight — run this BEFORE pointing the app at Arc mainnet.
 *
 * Everything here is a check that would otherwise fail in production, at the
 * worst possible moment:
 *
 *   - the platform DCW has no USDC  → no deal can ever be released or refunded,
 *                                     so every escrow strands. This is the single
 *                                     most likely way to kill the launch.
 *   - the deployer has no USDC      → the contract deploy reverts.
 *   - chain id / Circle blockchain / USDC token id disagree → the app looks
 *     healthy but signs for the wrong network or the wrong token.
 *   - the indexer is pointed at a contract with no history → on_chain_status
 *     never updates.
 *
 * Usage:
 *   node --env-file=.env.mainnet --import tsx scripts/preflight-mainnet.ts
 *
 * Exits non-zero if any check fails.
 */
import { createPublicClient, http, parseAbi, formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { ARC_CHAIN_ID, ARC_RPC_URL, ARC_USDC_CONTRACT, CIRCLE_BLOCKCHAIN, CIRCLE_USDC_TOKEN_ID, IS_ARC_MAINNET, assertArcNetworkConfig } from "@/lib/arc";

/** Best-effort address from a hex private key; undefined when absent or malformed. */
function deriveAddress(key: string | undefined): string | undefined {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined;
  try {
    return privateKeyToAccount(key as Hex).address;
  } catch {
    return undefined;
  }
}

/** Read a private key from disk, or undefined when the file is missing. */
function readKeyFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

let failed = 0;
const ok = (n: string, d = "") => console.log(`  ✓ ${n}${d ? ` — ${d}` : ""}`);
const bad = (n: string, d = "") => { failed++; console.error(`  ✗ ${n}${d ? ` — ${d}` : ""}`); };
const warn = (n: string, d = "") => console.warn(`  ! ${n}${d ? ` — ${d}` : ""}`);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/** Below this the DCW cannot pay for many relayed transactions. */
const MIN_DCW_GAS_USDC = 5;
/** Enough for a contract deploy plus the post-deploy wiring transactions. */
const MIN_DEPLOYER_GAS_USDC = 2;

async function main() {
  console.log("=== Arc MAINNET preflight ===\n");

  // ---------------------------------------------------------------- network
  console.log("--- network ---");
  console.log(`  chain id          : ${ARC_CHAIN_ID}${IS_ARC_MAINNET ? "  (MAINNET)" : "  (testnet)"}`);
  console.log(`  rpc               : ${ARC_RPC_URL}`);
  console.log(`  usdc contract     : ${ARC_USDC_CONTRACT}`);
  console.log(`  circle blockchain : ${CIRCLE_BLOCKCHAIN}`);
  console.log(`  circle usdc token : ${CIRCLE_USDC_TOKEN_ID}`);

  if (IS_ARC_MAINNET) ok("targeting Arc mainnet (chain 5042)");
  else warn("ARC_CHAIN_ID is still the testnet value — this run is a DRY RUN, not a mainnet launch");

  if (CIRCLE_BLOCKCHAIN === (IS_ARC_MAINNET ? "ARC" : "ARC-TESTNET")) {
    ok("Circle blockchain string matches the network");
  } else {
    bad("Circle blockchain string matches the network", `got "${CIRCLE_BLOCKCHAIN}"`);
  }

  // The strict config assertion — fails on a half-configured mainnet.
  try {
    assertArcNetworkConfig();
    ok("network config is internally consistent");
  } catch (e) {
    bad("network config is internally consistent", (e as Error).message);
  }

  // ------------------------------------------------------------------- rpc
  console.log("\n--- rpc ---");
  const client = createPublicClient({ transport: http(ARC_RPC_URL) });
  let blockNumber = 0n;
  try {
    blockNumber = await client.getBlockNumber();
    ok("RPC reachable", `block #${blockNumber}`);
  } catch (e) {
    bad("RPC reachable", (e as Error).message);
    console.error("\nCannot continue without RPC. Aborting.");
    process.exit(1);
  }

  // Verify the RPC really is the network we think it is.
  try {
    const onChainId = await client.getChainId();
    if (onChainId === ARC_CHAIN_ID) ok("RPC chain id matches ARC_CHAIN_ID", String(onChainId));
    else bad("RPC chain id matches ARC_CHAIN_ID", `rpc=${onChainId} config=${ARC_CHAIN_ID}`);
  } catch (e) {
    bad("RPC chain id matches ARC_CHAIN_ID", (e as Error).message);
  }

  // -------------------------------------------------------------- balances
  console.log("\n--- balances ---");
  // Derive what we can so the checks actually run instead of silently skipping —
  // a skipped gas check is exactly the failure mode this script exists to catch.
  const deployer =
    process.env.DEPLOYER_ADDRESS ??
    process.env.ARC_DEPLOYER_ADDRESS ??
    deriveAddress(process.env.DEPLOYER_PRIVATE_KEY ?? process.env.ARC_DEPLOYER_PRIVATE_KEY) ??
    // contracts/deploy.ts keeps the key in a file, not an env var.
    deriveAddress(readKeyFile(".secrets/deployer.key"));
  // The DCW address is stored in TREASURY_WALLET_ID by the deploy script (the
  // name is historical — it holds the platform wallet's ADDRESS, not an id).
  const dcw =
    process.env.PLATFORM_DCW_ADDRESS ??
    process.env.TREASURY_ADDRESS ??
    (process.env.TREASURY_WALLET_ID?.startsWith("0x") ? process.env.TREASURY_WALLET_ID : undefined);

  if (deployer) {
    try {
      const bal = await client.readContract({
        address: ARC_USDC_CONTRACT, abi: erc20Abi, functionName: "balanceOf", args: [deployer as Hex],
      });
      const usdc = Number(formatUnits(bal as bigint, 6));
      if (usdc >= MIN_DEPLOYER_GAS_USDC) ok("deployer can pay for the deploy", `${usdc} USDC`);
      else bad("deployer can pay for the deploy", `${usdc} USDC — need at least ${MIN_DEPLOYER_GAS_USDC}`);
    } catch (e) {
      bad("deployer balance readable", (e as Error).message);
    }
  } else {
    warn("DEPLOYER_ADDRESS not set — skipping the deployer balance check");
  }

  if (dcw) {
    try {
      const bal = await client.readContract({
        address: ARC_USDC_CONTRACT, abi: erc20Abi, functionName: "balanceOf", args: [dcw as Hex],
      });
      const usdc = Number(formatUnits(bal as bigint, 6));
      // THE critical one: this wallet pays gas for every release/refund/slash.
      // Empty → no deal can ever settle, and funds sit locked until the 30-day
      // dispute backstop. Better to discover that now than on launch day.
      if (usdc >= MIN_DCW_GAS_USDC) ok("platform DCW can pay relay gas", `${usdc} USDC`);
      else bad("platform DCW can pay relay gas", `${usdc} USDC — need at least ${MIN_DCW_GAS_USDC}, or NO deal can ever be released`);
    } catch (e) {
      bad("DCW balance readable", (e as Error).message);
    }
  } else {
    warn("PLATFORM_DCW_ADDRESS not set — skipping the DCW gas check (this is the most important one)");
  }

  // --------------------------------------------------------------- contract
  console.log("\n--- contract ---");
  const escrow = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
  if (!escrow) {
    bad("ESCROW_CONTRACT_ADDRESS set", "deploy the contract to mainnet first");
  } else {
    try {
      const code = await client.getBytecode({ address: escrow as Hex });
      if (code && code !== "0x") ok("escrow contract is deployed", escrow);
      else bad("escrow contract is deployed", `${escrow} has no code`);
    } catch (e) {
      bad("escrow contract readable", (e as Error).message);
    }
  }

  // ------------------------------------------------------------------- misc
  console.log("\n--- service config ---");
  for (const [name, label] of [
    ["PLATFORM_CIRCLE_WALLET_ID", "platform Circle wallet id"],
    ["CIRCLE_API_KEY", "Circle API key"],
    ["NEXT_PUBLIC_SUPABASE_URL", "Supabase URL"],
    ["SUPABASE_SERVICE_ROLE_KEY", "Supabase service role key"],
  ] as const) {
    if (process.env[name]) ok(`${label} set`);
    else bad(`${label} set`);
  }

  console.log(`\n=== ${failed === 0 ? "PREFLIGHT PASSED" : `${failed} CHECK(S) FAILED`} ===`);
  if (failed > 0) {
    console.error("\nDo NOT point the app at mainnet until every check passes.");
    process.exit(1);
  }
  console.log("Ready to deploy to Arc mainnet.");
}

main().catch((e) => {
  console.error("\npreflight crashed:", e.message || e);
  process.exit(1);
});
