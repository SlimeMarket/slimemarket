/**
 * Verify the platform DCW can actually RELAY the escrow admin actions.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other path is proven by scripts/e2e-escrow-testnet.ts (buyer/seller sign
 * from their own EOAs). But `releaseEscrow` / `refundEscrow` /
 * `refundEscrowWithSlash` are `onlyMiddleman`, and the only middleman is the
 * platform DCW — a Circle developer-controlled wallet whose key lives with
 * Circle. A raw-key script cannot sign for it, so this path was the ONE part of
 * the escrow system that had never been exercised.
 *
 * If `releaseEscrow` fails on launch day, every deal strands and the platform is
 * dead. That makes this the highest-value thing to verify before mainnet.
 *
 * This drives the SAME module the API routes call
 * (lib/contracts/escrow-client.ts → Circle SDK), so a green run means the route
 * works too — only HTTP auth sits in between.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/verify-dcw-relay.ts
 */
import {
  createPublicClient, createWalletClient, http,
  parseAbi, parseUnits, formatUnits, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import {
  releaseEscrowOnChain,
  refundEscrowOnChain,
  refundEscrowWithSlashOnChain,
  isContractReady,
} from "@/lib/contracts/escrow-client";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const ESCROW = (process.env.ESCROW_CONTRACT_ADDRESS ?? "") as Hex;
const USDC = (process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS ?? "") as Hex;

const chain = {
  id: CHAIN_ID, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const escrowAbi = parseAbi([
  "function createEscrowDealAsSeller(address buyer, uint256 price, uint256 deliveryWindow, uint256 collateral) returns (uint256)",
  "function fundEscrowDeal(uint256 dealId)",
  "function dealCounter() view returns (uint256)",
  "function deals(uint256) view returns (address buyer, address seller, uint256 price, uint256 fee, uint256 collateral, uint256 collateralReturned, uint256 createdAt, uint256 deliveryDeadline, uint256 confirmDeadline, uint256 disputedAt, bool buyerDeposited, bool delivered, bool buyerConfirmed, bool disputed, bool released, bool refunded, uint256 deliveryWindow)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const PRICE = parseUnits("0.01", 6);
const COLLATERAL = parseUnits("0.005", 6);
const WINDOW = 24 * 60 * 60;

let passed = 0, failed = 0;
const ok = (n: string, d = "") => { passed++; console.log(`  ✓ ${n}${d ? ` — ${d}` : ""}`); };
const bad = (n: string, d = "") => { failed++; console.error(`  ✗ ${n}${d ? ` — ${d}` : ""}`); };

async function main() {
  if (!isContractReady()) {
    console.error("escrow relay not configured (contract address / platform wallet id / Circle SDK)");
    process.exit(1);
  }
  if (!ESCROW || !USDC) {
    console.error("ESCROW_CONTRACT_ADDRESS / NEXT_PUBLIC_USDC_CONTRACT_ADDRESS not set");
    process.exit(1);
  }

  const publicClient = createPublicClient({ transport: http(RPC) });
  const buyer = privateKeyToAccount(readFileSync(".secrets/test-buyer.key", "utf8").trim() as Hex);
  const seller = privateKeyToAccount(readFileSync(".secrets/test-seller.key", "utf8").trim() as Hex);
  const buyerWallet = createWalletClient({ account: buyer, chain, transport: http(RPC) });
  const sellerWallet = createWalletClient({ account: seller, chain, transport: http(RPC) });

  const send = async (hash: Hex, label: string) => {
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (r.status !== "success") throw new Error(`${label}: tx reverted`);
    return r;
  };
  const readDeal = async (id: bigint) => {
    const r = (await publicClient.readContract({
      address: ESCROW, abi: escrowAbi, functionName: "deals", args: [id],
    })) as unknown as readonly unknown[];
    return {
      buyer: r[0] as string, seller: r[1] as string,
      collateral: r[4] as bigint, collateralReturned: r[5] as bigint,
      buyerDeposited: r[10] as boolean, released: r[14] as boolean, refunded: r[15] as boolean,
    };
  };

  console.log("=== Platform DCW relay verification (Arc Testnet) ===");
  console.log("  escrow :", ESCROW);
  console.log("  DCW    :", process.env.PLATFORM_CIRCLE_WALLET_ID);

  /** Open a shell, fund it, and return the on-chain deal id. */
  const makeLiveDeal = async (): Promise<bigint> => {
    const id = await publicClient.readContract({
      address: ESCROW, abi: escrowAbi, functionName: "dealCounter",
    });
    await send(await sellerWallet.writeContract({
      address: USDC, abi: erc20Abi, functionName: "approve",
      args: [ESCROW, COLLATERAL], chain, account: seller,
    }), "seller approve");
    await send(await sellerWallet.writeContract({
      address: ESCROW, abi: escrowAbi, functionName: "createEscrowDealAsSeller",
      args: [buyer.address, PRICE, BigInt(WINDOW), COLLATERAL], chain, account: seller,
    }), "shell");
    await send(await buyerWallet.writeContract({
      address: USDC, abi: erc20Abi, functionName: "approve",
      args: [ESCROW, PRICE + 200n], chain, account: buyer,
    }), "buyer approve");
    await send(await buyerWallet.writeContract({
      address: ESCROW, abi: escrowAbi, functionName: "fundEscrowDeal",
      args: [id], chain, account: buyer,
    }), "fund");
    return id;
  };

  /** Poll the chain until the deal reports the expected terminal state. */
  const waitFor = async (id: bigint, field: "released" | "refunded", tries = 20) => {
    for (let i = 0; i < tries; i++) {
      const d = await readDeal(id);
      if (d[field]) return d;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  };

  // ---- 1. releaseEscrow (the happy path — most critical) ----
  console.log("\n--- 1. DCW relays releaseEscrow ---");
  {
    const id = await makeLiveDeal();
    const before = await publicClient.readContract({
      address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [seller.address],
    });
    const res = await releaseEscrowOnChain(id.toString(), process.env.PLATFORM_CIRCLE_WALLET_ID ?? "");
    if (!res?.id) bad("DCW accepted releaseEscrow", "no transaction id returned");
    else ok("DCW accepted releaseEscrow", `circleTx=${res.id.slice(0, 8)}…`);

    const d = await waitFor(id, "released");
    if (d?.released) ok("deal RELEASED on-chain", `dealId=${id}`);
    else bad("deal RELEASED on-chain", "timed out waiting for the release event");

    const after = await publicClient.readContract({
      address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [seller.address],
    });
    if (d && after > before) ok("seller received the payout", `+${formatUnits(after - before, 6)} USDC`);
    else bad("seller received the payout");
  }

  // ---- 2. refundEscrow ----
  console.log("\n--- 2. DCW relays refundEscrow ---");
  {
    const id = await makeLiveDeal();
    const res = await refundEscrowOnChain(id.toString(), process.env.PLATFORM_CIRCLE_WALLET_ID ?? "");
    if (res?.id) ok("DCW accepted refundEscrow", `circleTx=${res.id.slice(0, 8)}…`);
    else bad("DCW accepted refundEscrow", "no transaction id returned");

    const d = await waitFor(id, "refunded");
    if (d?.refunded) ok("deal REFUNDED on-chain", `dealId=${id}`);
    else bad("deal REFUNDED on-chain", "timed out");
    if (d && d.collateralReturned === COLLATERAL) ok("collateral returned to the seller");
    else bad("collateral returned to the seller", `returned=${d?.collateralReturned}`);
  }

  // ---- 3. refundEscrowWithSlash (fraud ruling) ----
  console.log("\n--- 3. DCW relays refundEscrowWithSlash ---");
  {
    const id = await makeLiveDeal();
    const before = await publicClient.readContract({
      address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address],
    });
    const res = await refundEscrowWithSlashOnChain(id.toString(), process.env.PLATFORM_CIRCLE_WALLET_ID ?? "");
    if (res?.id) ok("DCW accepted refundEscrowWithSlash", `circleTx=${res.id.slice(0, 8)}…`);
    else bad("DCW accepted refundEscrowWithSlash", "no transaction id returned");

    const d = await waitFor(id, "refunded");
    if (d?.refunded) ok("deal slashed on-chain", `dealId=${id}`);
    else bad("deal slashed on-chain", "timed out");

    const after = await publicClient.readContract({
      address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address],
    });
    const gained = after - before;
    // Buyer gets price back AND the seller's collateral as compensation.
    if (gained >= PRICE + COLLATERAL) {
      ok("buyer compensated with price + collateral", `+${formatUnits(gained, 6)} USDC`);
    } else {
      bad("buyer compensated with price + collateral", `got ${formatUnits(gained, 6)}`);
    }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  console.log("✅ The platform DCW can relay every admin escrow action.");
}

main().catch((e) => {
  console.error("\nDCW relay verification failed:", e.shortMessage || e.message || e);
  process.exit(1);
});
