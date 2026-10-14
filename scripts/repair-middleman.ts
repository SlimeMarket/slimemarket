/**
 * .C — ONE-TIME on-chain repair for the addMiddleman ordering bug.
 *
 * Background: contracts/deploy.ts used to run addMiddleman(platform) AFTER
 * transferOwnership(platform) — but addMiddleman is onlyOwner, so once the
 * platform DCW became owner the deployer key could no longer call it and the
 * step failed silently. Result on the live contract (verified 2026-08-22):
 *   middlemen[platform] == false → releaseEscrow/refundEscrow (WL/rekber,
 *   onlyMiddleman) revert. Marketplace orders are UNAFFECTED (onlyOperator
 *   also accepts msg.sender == platform).
 *
 * The deployed contract's owner IS the platform DCW, so the fix must be
 * submitted THROUGH Circle as a contract-execution transaction signed by the
 * platform wallet (same relay pattern as lib/contracts/escrow-client.ts).
 *
 * Run when the Circle API is reachable (NOT through a corporate proxy):
 *   node --env-file=.env.local --import tsx scripts/repair-middleman.ts
 *
 * Idempotent: verifies the flag first, no-ops if already repaired, and
 * re-verifies after confirmation.
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, type Hex } from "viem";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const ESCROW = process.env.ESCROW_CONTRACT_ADDRESS as Hex;
const PLATFORM_WALLET = process.env.PLATFORM_CIRCLE_WALLET_ID!;
const PLATFORM_ADDR = (process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS || process.env.TREASURY_WALLET_ID) as Hex;

const VIEW_ABI = [
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "middlemen", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!ESCROW || !PLATFORM_WALLET || !PLATFORM_ADDR) {
    console.error("missing env: ESCROW_CONTRACT_ADDRESS / PLATFORM_CIRCLE_WALLET_ID / NEXT_PUBLIC_AGENT_WALLET_ADDRESS");
    process.exit(1);
  }
  const rpc = createPublicClient({ transport: http(RPC) });
  const isMm = (await rpc.readContract({ address: ESCROW, abi: VIEW_ABI, functionName: "middlemen", args: [PLATFORM_ADDR] })) as boolean;
  const owner = (await rpc.readContract({ address: ESCROW, abi: VIEW_ABI, functionName: "owner" })) as string;
  console.log(`escrow owner   : ${owner}`);
  console.log(`middleman flag : ${isMm}`);
  if (isMm) { console.log("✓ already repaired — nothing to do"); return; }
  if (owner.toLowerCase() !== PLATFORM_ADDR.toLowerCase()) {
    console.error(`✗ owner is not the platform DCW (${PLATFORM_ADDR}) — this script assumes owner == platform. Fix ownership first.`);
    process.exit(1);
  }

  const sdk = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
  console.log("\nsubmitting addMiddleman(platform) via platform DCW...");
  const created = await sdk.createContractExecutionTransaction({
    walletId: PLATFORM_WALLET,
    contractAddress: ESCROW,
    abiFunctionSignature: "addMiddleman(address)",
    abiParameters: [PLATFORM_ADDR],
    fee: { type: "level", config: { feeLevel: "LOW" } },
    idempotencyKey: crypto.randomUUID(),
  });
  // Our codebase's proven shape (lib/contracts/escrow-client.ts callContract):
  // createContractExecutionTransaction returns the id on data.id.
  const createdData = created.data as { id?: string; transaction?: { id?: string } } | undefined;
  const txId = createdData?.id ?? createdData?.transaction?.id;
  if (!txId) { console.error("Circle rejected:", JSON.stringify(created.data ?? created).slice(0, 300)); process.exit(1); }
  console.log(`circle tx ${txId} created — polling...`);

  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const st = await sdk.getTransaction({ id: txId });
    const tx = st.data?.transaction as { state?: string; errorReason?: unknown } | undefined;
    const state = tx?.state;
    if (state === "CONFIRMED" || state === "COMPLETE") break;
    if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
      console.error(`Circle tx ${state}:`, JSON.stringify(tx?.errorReason ?? {}).slice(0, 200));
      process.exit(1);
    }
    if (i % 6 === 5) console.log(`  ...${(i + 1) * 5}s (state=${state ?? "?"})`);
  }
  await sleep(3000);
  const after = (await rpc.readContract({ address: ESCROW, abi: VIEW_ABI, functionName: "middlemen", args: [PLATFORM_ADDR] })) as boolean;
  if (after) console.log("\n✓ REPAIRED — middlemen[platform] = true, WL escrow release/refund restored");
  else { console.error("\n✗ flag still false — check the Circle tx in Console"); process.exit(1); }
}

main().catch((e) => { console.error("repair failed:", e); process.exit(1); });
