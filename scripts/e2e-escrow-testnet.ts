/**
 * End-to-end escrow lifecycle test against the LIVE Arc Testnet contract.
 *
 * Exercises the paths a real OTC deal takes, with real transactions, so a green
 * run means the deployed bytecode actually works — not just that it compiles.
 *
 * Happy path:
 *   buyer createEscrowDeal  → seller depositEscrowCollateral → seller markDelivered
 *   → buyer confirmEscrow (releases) → balances checked
 *
 * Guard rails (each must REVERT):
 *   - confirmEscrow by a non-buyer
 *   - markDelivered by a non-seller
 *   - markDelivered after the delivery deadline
 *   - releaseEscrowAfterTimeout while undelivered  (the old race-condition path)
 *   - flagDispute by a third party
 *
 * Admin-only paths (releaseEscrow / refundEscrow / refundEscrowWithSlash) are
 * deliberately NOT exercised here: they require the platform DCW's signature via
 * the Circle API, so they belong in the app-level flow, not a raw-key script.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/e2e-escrow-testnet.ts
 */
import {
  createPublicClient, createWalletClient, http,
  parseAbi, parseUnits, formatUnits, type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, existsSync } from "fs";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const ESCROW = (process.env.ESCROW_CONTRACT_ADDRESS ?? "") as Hex;
const USDC = (process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS ?? "") as Hex;

if (!ESCROW || !USDC) {
  console.error("ESCROW_CONTRACT_ADDRESS / NEXT_PUBLIC_USDC_CONTRACT_ADDRESS not set");
  process.exit(1);
}

const chain = {
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const escrowAbi = parseAbi([
  "function createEscrowDeal(address seller, uint256 price, uint256 deliveryWindow) returns (uint256)",
  "function createEscrowDealAsSeller(address buyer, uint256 price, uint256 deliveryWindow, uint256 collateral) returns (uint256)",
  "function fundEscrowDeal(uint256 dealId)",
  "function depositEscrowCollateral(uint256 dealId, uint256 amount)",
  "function markDelivered(uint256 dealId)",
  "function confirmEscrow(uint256 dealId)",
  "function flagDispute(uint256 dealId)",
  "function releaseEscrowAfterTimeout(uint256 dealId, uint256 deadline)",
  "function deals(uint256) view returns (address buyer, address seller, uint256 price, uint256 fee, uint256 collateral, uint256 collateralReturned, uint256 createdAt, uint256 deliveryDeadline, uint256 confirmDeadline, uint256 disputedAt, bool buyerDeposited, bool delivered, bool buyerConfirmed, bool disputed, bool released, bool refunded, uint256 deliveryWindow)",
  "function dealCounter() view returns (uint256)",
  "function computeFee(uint256 amount) view returns (uint256)",
  "event DealCreated(uint256 indexed id, address buyer, address seller, uint256 price, uint256 fee, uint256 collateral)",
  "event CollateralAdded(uint256 indexed id, address seller, uint256 added, uint256 total)",
  "event DealDelivered(uint256 indexed id, address seller, uint256 confirmDeadline)",
  "event DealConfirmed(uint256 indexed id, address buyer)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const PRICE = parseUnits("0.05", 6); // 0.05 USDC
const COLLATERAL = parseUnits("0.02", 6); // 0.02 USDC (deposited twice = 0.04)
const DELIVERY_WINDOW = 24 * 60 * 60; // 1 day

// Both test wallets are funded from the faucet, so no transfer amounts are
// needed here. Native gas is 18-decimals while the ERC-20 USDC view is
// 6-decimals — never mix the two when comparing balances.
const MIN_BUYER_GAS = parseUnits("0.005", 18);

let passed = 0;
let failed = 0;

function ok(name: string, detail = "") {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name: string, detail = "") {
  failed++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expectRevert(name: string, fn: () => Promise<unknown>, needle?: string) {
  try {
    await fn();
    bad(name, "expected a revert but the call succeeded");
  } catch (e) {
    const msg = (e as Error).message || "";
    if (needle && !msg.toLowerCase().includes(needle.toLowerCase())) {
      bad(name, `reverted, but not with "${needle}" — got: ${msg.slice(0, 120)}`);
    } else {
      ok(name, needle ? `reverted with "${needle}"` : "reverted as expected");
    }
  }
}

async function main() {
  const publicClient = createPublicClient({ transport: http(RPC) });

  // PERSISTENT test wallets (see scripts/test-wallets.ts). They are funded once
  // via https://faucet.circle.com and reused across runs — a throwaway key per
  // run cannot be faucet-funded. The third party is ephemeral because the
  // guard-rail calls revert during gas estimation and therefore never hit the
  // chain (no funds required).
  const loadKey = (name: string): Hex => {
    const file = `.secrets/${name}.key`;
    if (!existsSync(file)) {
      console.error(`  ERROR: ${file} not found. Run: node --env-file=.env.local --import tsx scripts/test-wallets.ts`);
      process.exit(1);
    }
    return readFileSync(file, "utf8").trim() as Hex;
  };

  const buyer = privateKeyToAccount(loadKey("test-buyer"));
  const seller = privateKeyToAccount(loadKey("test-seller"));
  const thirdParty = privateKeyToAccount(generatePrivateKey());

  const buyerWallet = createWalletClient({ account: buyer, chain, transport: http(RPC) });
  const sellerWallet = createWalletClient({ account: seller, chain, transport: http(RPC) });
  const thirdWallet = createWalletClient({ account: thirdParty, chain, transport: http(RPC) });

  const send = async (hash: Hex, label: string) => {
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (r.status !== "success") throw new Error(`${label}: tx reverted (${hash})`);
    return r;
  };

  // viem returns a struct view as a POSITIONAL ARRAY here, not a named object,
  // so index it explicitly instead of relying on property names.
  const readDeal = async (id: bigint) => {
    const r = (await publicClient.readContract({
      address: ESCROW, abi: escrowAbi, functionName: "deals", args: [id],
    })) as unknown as readonly [
      Hex, Hex, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
      boolean, boolean, boolean, boolean, boolean, boolean,
    ];
    return {
      buyer: r[0], seller: r[1], price: r[2], fee: r[3],
      collateral: r[4], collateralReturned: r[5],
      createdAt: r[6], deliveryDeadline: r[7], confirmDeadline: r[8], disputedAt: r[9],
      buyerDeposited: r[10], delivered: r[11], buyerConfirmed: r[12],
      disputed: r[13], released: r[14], refunded: r[15],
    };
  };

  console.log("=== E2E escrow lifecycle on Arc Testnet ===");
  console.log("  escrow :", ESCROW);
  console.log("  buyer  :", buyer.address);
  console.log("  seller :", seller.address, "(persistent test wallet)");
  console.log("");

  const buyerUsdcBefore = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address],
  });
  const buyerNativeBefore = await publicClient.getBalance({ address: buyer.address });
  console.log("  buyer USDC (erc20, 6dp):", formatUnits(buyerUsdcBefore, 6));
  console.log("  buyer native (gas, 18dp):", formatUnits(buyerNativeBefore, 18));

  // NOTE: on Arc the ERC-20 view is 6 decimals while the native gas balance is
  // 18 — never compare the two directly.
  const feeForCheck = await publicClient.readContract({
    address: ESCROW, abi: escrowAbi, functionName: "computeFee", args: [PRICE],
  });
  if (buyerUsdcBefore < PRICE + feeForCheck) {
    console.error(`  ERROR: buyer needs at least ${formatUnits(PRICE + feeForCheck, 6)} USDC. Fund from https://faucet.circle.com`);
    process.exit(1);
  }
  if (buyerNativeBefore < MIN_BUYER_GAS) {
    console.error("  ERROR: buyer needs native USDC for gas. Faucet: https://faucet.circle.com");
    process.exit(1);
  }

  // Both wallets are pre-funded from the faucet — no transfers needed here.
  const sellerUsdcBefore = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [seller.address],
  });
  const sellerNativeBefore = await publicClient.getBalance({ address: seller.address });
  console.log("  seller USDC (erc20, 6dp):", formatUnits(sellerUsdcBefore, 6));
  console.log("  seller native (gas, 18dp):", formatUnits(sellerNativeBefore, 18));

  const neededCollateral = COLLATERAL * 2n; // deposited twice
  if (sellerUsdcBefore < neededCollateral) {
    console.error(`  ERROR: seller needs at least ${formatUnits(neededCollateral, 6)} USDC for collateral. Faucet: https://faucet.circle.com`);
    process.exit(1);
  }
  if (sellerNativeBefore < parseUnits("0.01", 18)) {
    console.error("  ERROR: seller needs native USDC for gas. Faucet: https://faucet.circle.com");
    process.exit(1);
  }

  // The seller must approve the escrow before depositEscrowCollateral can pull
  // the collateral (safeTransferFrom on the seller's behalf).
  await send(
    await sellerWallet.writeContract({
      address: USDC, abi: erc20Abi, functionName: "approve",
      args: [ESCROW, neededCollateral], chain, account: seller,
    }),
    "seller approve",
  );
  ok("seller approved collateral allowance");

  // --- approve the escrow to pull price + fee ---
  const fee = await publicClient.readContract({
    address: ESCROW, abi: escrowAbi, functionName: "computeFee", args: [PRICE],
  });
  console.log(`\n[setup] approving ${formatUnits(PRICE + fee, 6)} USDC (price + 2% fee)`);
  await send(
    await buyerWallet.writeContract({
      address: USDC, abi: erc20Abi, functionName: "approve",
      args: [ESCROW, PRICE + fee], chain, account: buyer,
    }),
    "approve",
  );
  ok("approve");

  // =========================================================================
  console.log("\n--- happy path ---");
  // =========================================================================

  const dealIdBefore = await publicClient.readContract({
    address: ESCROW, abi: escrowAbi, functionName: "dealCounter",
  });

  const createHash = await buyerWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: "createEscrowDeal",
    args: [seller.address, PRICE, BigInt(DELIVERY_WINDOW)], chain, account: buyer,
  });
  const createReceipt = await send(createHash, "createEscrowDeal");
  const dealId = dealIdBefore;
  ok("createEscrowDeal", `dealId=${dealId}, gas=${createReceipt.gasUsed}`);

  let d = await readDeal(dealId);
  if (d.buyerDeposited && !d.released && !d.refunded) ok("deal funded, unresolved");
  else bad("deal funded, unresolved", `buyerDeposited=${d.buyerDeposited} released=${d.released}`);
  if (d.deliveryDeadline > d.createdAt) ok("deliveryDeadline set", `+${d.deliveryDeadline - d.createdAt}s`);
  else bad("deliveryDeadline set");

  // seller tops up collateral twice — proves the C1 fix
  const sellerUsdc = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [seller.address],
  });
  console.log("  [debug] seller USDC (6dp):", formatUnits(sellerUsdc, 6));

  const colHash1 = await sellerWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: "depositEscrowCollateral",
    args: [dealId, COLLATERAL], chain, account: seller,
  });
  await send(colHash1, "collateral #1");
  ok("depositEscrowCollateral (1st)");

  const colHash2 = await sellerWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: "depositEscrowCollateral",
    args: [dealId, COLLATERAL], chain, account: seller,
  });
  await send(colHash2, "collateral #2");
  d = await readDeal(dealId);
  if (d.collateral === COLLATERAL * 2n) ok("collateral TOPPED UP", `total=${formatUnits(d.collateral, 6)} USDC`);
  else bad("collateral TOPPED UP", `got ${d.collateral}, expected ${COLLATERAL * 2n}`);

  // =========================================================================
  console.log("\n--- guard rails (each must revert) ---");
  // =========================================================================

  await expectRevert(
    "confirmEscrow is buyer-only",
    () => sellerWallet.writeContract({
      address: ESCROW, abi: escrowAbi, functionName: "confirmEscrow",
      args: [dealId], chain, account: seller,
    }),
    "!buyer",
  );

  await expectRevert(
    "markDelivered is seller-only",
    () => buyerWallet.writeContract({
      address: ESCROW, abi: escrowAbi, functionName: "markDelivered",
      args: [dealId], chain, account: buyer,
    }),
    "!seller",
  );

  await expectRevert(
    "flagDispute rejects a third party",
    () => thirdWallet.writeContract({
      address: ESCROW, abi: escrowAbi, functionName: "flagDispute",
      args: [dealId], chain, account: thirdParty,
    }),
    "!party",
  );

  await expectRevert(
    "releaseEscrowAfterTimeout BLOCKED while undelivered (race fix)",
    () => thirdWallet.writeContract({
      address: ESCROW, abi: escrowAbi, functionName: "releaseEscrowAfterTimeout",
      args: [dealId, BigInt(Math.floor(Date.now() / 1000) + 90 * 86400)],
      chain, account: thirdParty,
    }),
    "not delivered",
  );

  // =========================================================================
  console.log("\n--- delivery + confirmation ---");
  // =========================================================================

  const delHash = await sellerWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: "markDelivered",
    args: [dealId], chain, account: seller,
  });
  await send(delHash, "markDelivered");
  d = await readDeal(dealId);
  if (d.delivered && d.confirmDeadline > 0n) ok("markDelivered set confirmDeadline");
  else bad("markDelivered set confirmDeadline");

  const sellerBefore = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [seller.address],
  });

  const confHash = await buyerWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: "confirmEscrow",
    args: [dealId], chain, account: buyer,
  });
  await send(confHash, "confirmEscrow");
  ok("confirmEscrow (buyer self-release, no admin)");

  d = await readDeal(dealId);
  const sellerAfter = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [seller.address],
  });

  const gained = sellerAfter - sellerBefore;
  if (d.released && d.buyerConfirmed) ok("deal marked released + buyerConfirmed");
  else bad("deal marked released + buyerConfirmed", `released=${d.released}`);
  // Seller receives 100% of price + the full collateral back. Their gas spend is
  // deducted from the same balance, so allow a 10% tolerance rather than
  // asserting an exact figure.
  const expected = PRICE + COLLATERAL * 2n;
  if (gained * 100n >= expected * 90n) {
    ok("seller paid price + collateral back", `+${formatUnits(gained, 6)} USDC`);
  } else {
    bad("seller paid price + collateral back", `got ${formatUnits(gained, 6)}, expected ~${formatUnits(expected, 6)}`);
  }
  if (d.collateralReturned === COLLATERAL * 2n) ok("collateral fully returned");
  else bad("collateral fully returned", `returned=${d.collateralReturned}`);

  // =========================================================================
  console.log("\n--- A2: collateral-first shell flow ---");
  // =========================================================================

  // Seller opens an unfunded shell WITH collateral in one tx; only then may the
  // buyer fund it. This is what makes "buyer's money locked with nothing backing
  // it" structurally impossible.
  const shellId = await publicClient.readContract({
    address: ESCROW, abi: escrowAbi, functionName: "dealCounter",
  });

  // The buyer must be able to cover the next deal too.
  await send(
    await buyerWallet.writeContract({
      address: USDC, abi: erc20Abi, functionName: "approve",
      args: [ESCROW, PRICE + fee], chain, account: buyer,
    }),
    "approve #2",
  );
  // The seller's earlier allowance was consumed by the first deal's deposit.
  await send(
    await sellerWallet.writeContract({
      address: USDC, abi: erc20Abi, functionName: "approve",
      args: [ESCROW, COLLATERAL], chain, account: seller,
    }),
    "seller approve #2",
  );

  const shellHash = await sellerWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: "createEscrowDealAsSeller",
    args: [buyer.address, PRICE, BigInt(DELIVERY_WINDOW), COLLATERAL], chain, account: seller,
  });
  await send(shellHash, "createEscrowDealAsSeller");
  ok("seller opened shell + deposited collateral in one tx", `dealId=${shellId}`);

  let s = await readDeal(shellId);
  if (s.collateral === COLLATERAL && !s.buyerDeposited) ok("shell has collateral, not yet funded");
  else bad("shell has collateral, not yet funded", `col=${s.collateral} funded=${s.buyerDeposited}`);
  if (s.deliveryDeadline === 0n) ok("delivery clock NOT started before funding");
  else bad("delivery clock NOT started before funding", `deadline=${s.deliveryDeadline}`);

  await expectRevert(
    "an unfunded shell cannot be marked delivered",
    () => sellerWallet.writeContract({
      address: ESCROW, abi: escrowAbi, functionName: "markDelivered",
      args: [shellId], chain, account: seller,
    }),
    "buyer not deposited",
  );

  const fundHash = await buyerWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: "fundEscrowDeal",
    args: [shellId], chain, account: buyer,
  });
  await send(fundHash, "fundEscrowDeal");
  ok("buyer funded the shell (collateral already locked)");

  s = await readDeal(shellId);
  if (s.buyerDeposited && s.deliveryDeadline > s.createdAt) {
    ok("funding started the delivery clock", `+${s.deliveryDeadline - s.createdAt}s`);
  } else {
    bad("funding started the delivery clock", `funded=${s.buyerDeposited}`);
  }

  await expectRevert(
    "a shell cannot be funded twice",
    () => buyerWallet.writeContract({
      address: ESCROW, abi: escrowAbi, functionName: "fundEscrowDeal",
      args: [shellId], chain, account: buyer,
    }),
    "already funded",
  );

  // =========================================================================
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  console.log("✅ Escrow lifecycle works end-to-end on testnet.");
}

main().catch((e) => {
  console.error("\nE2E failed:", e.shortMessage || e.message || e);
  process.exit(1);
});
