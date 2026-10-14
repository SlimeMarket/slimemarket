/**
 * Verify the freshly deployed MarketEscrow on Arc Testnet.
 *
 * Reads every new timing constant + the admin/role state so we can confirm the
 * deployed bytecode actually carries the settlement hardening (C1–C6) rather
 * than trusting the deploy log.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/verify-escrow-deploy.ts
 */
import { createPublicClient, http, type Hex, parseAbi } from "viem";

const ADDR = (process.env.ESCROW_CONTRACT_ADDRESS ?? "") as Hex;
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const PLATFORM = (process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS ?? "") as Hex;

if (!ADDR) {
  console.error("ESCROW_CONTRACT_ADDRESS not set");
  process.exit(1);
}

const abi = parseAbi([
  "function owner() view returns (address)",
  "function treasury() view returns (address)",
  "function platform() view returns (address)",
  "function paused() view returns (bool)",
  "function orderCounter() view returns (uint256)",
  "function dealCounter() view returns (uint256)",
  "function pendingFees() view returns (uint256)",
  "function middlemen(address) view returns (bool)",
  "function FEE_BPS() view returns (uint256)",
  "function SELLER_FEE_BPS() view returns (uint256)",
  "function MIN_DELIVERY_WINDOW() view returns (uint256)",
  "function MAX_DELIVERY_WINDOW() view returns (uint256)",
  "function CONFIRM_WINDOW() view returns (uint256)",
  "function DISPUTE_BACKSTOP() view returns (uint256)",
  "function ESCROW_TIMEOUT() view returns (uint256)",
]);

const DAY = 86_400;

async function main() {
  const client = createPublicClient({ transport: http(RPC) });

  const read = <T>(fn: string, args?: unknown[]) =>
    client.readContract({ address: ADDR, abi, functionName: fn, args } as never) as Promise<T>;

  const [
    owner, treasury, platform, paused,
    orderCounter, dealCounter, pendingFees,
    feeBps, sellerFeeBps,
    minWin, maxWin, confirmWin, backstop, escrowTimeout,
  ] = await Promise.all([
    read<Hex>("owner"),
    read<Hex>("treasury"),
    read<Hex>("platform"),
    read<boolean>("paused"),
    read<bigint>("orderCounter"),
    read<bigint>("dealCounter"),
    read<bigint>("pendingFees"),
    read<bigint>("FEE_BPS"),
    read<bigint>("SELLER_FEE_BPS"),
    read<bigint>("MIN_DELIVERY_WINDOW"),
    read<bigint>("MAX_DELIVERY_WINDOW"),
    read<bigint>("CONFIRM_WINDOW"),
    read<bigint>("DISPUTE_BACKSTOP"),
    read<bigint>("ESCROW_TIMEOUT"),
  ]);

  const isMm = PLATFORM
    ? await read<boolean>("middlemen", [PLATFORM])
    : false;

  const code = await client.getBytecode({ address: ADDR });

  const days = (v: bigint) => `${Number(v) / DAY} days`;

  console.log("=== MarketEscrow on Arc Testnet ===");
  console.log("  address:      ", ADDR);
  console.log("  bytecode:     ", code ? `${(code.length - 2) / 2} bytes (deployed)` : "NONE — not a contract!");
  console.log("");
  console.log("  owner:        ", owner);
  console.log("  treasury:     ", treasury);
  console.log("  platform:     ", platform);
  console.log("  paused:       ", paused);
  console.log("  middlemen[platform]:", isMm);
  console.log("");
  console.log("  FEE_BPS:            ", `${Number(feeBps) / 100}% (buyer, both flows)`);
  console.log("  SELLER_FEE_BPS:     ", `${Number(sellerFeeBps) / 100}% (marketplace only)`);
  console.log("");
  console.log("  --- settlement windows (NEW) ---");
  console.log("  MIN_DELIVERY_WINDOW:", days(minWin), `(${minWin}s)`);
  console.log("  MAX_DELIVERY_WINDOW:", days(maxWin), `(${maxWin}s)`);
  console.log("  CONFIRM_WINDOW:     ", days(confirmWin), `(${confirmWin}s)`);
  console.log("  DISPUTE_BACKSTOP:   ", days(backstop), `(${backstop}s)`);
  console.log("  ESCROW_TIMEOUT:     ", days(escrowTimeout), "(marketplace orders only)");
  console.log("");
  console.log("  counters:     orders =", orderCounter.toString(), "| deals =", dealCounter.toString(), "| pendingFees =", pendingFees.toString());

  // Hard assertions — the point of this script is to FAIL LOUDLY if the
  // deployed bytecode is not the hardened version.
  const problems: string[] = [];
  if (!code || code === "0x") problems.push("no bytecode at ESCROW_CONTRACT_ADDRESS");
  if (!isMm) problems.push("middlemen[platform] is false — release/refund would revert");
  if (owner.toLowerCase() !== PLATFORM.toLowerCase()) problems.push(`owner is ${owner}, expected platform ${PLATFORM}`);
  if (treasury.toLowerCase() !== PLATFORM.toLowerCase()) problems.push(`treasury is ${treasury}, expected platform ${PLATFORM}`);
  if (paused) problems.push("contract is PAUSED");
  // The four constants below only exist on the hardened build — a zero/missing
  // value means we deployed the OLD bytecode by accident.
  if (minWin === 0n) problems.push("MIN_DELIVERY_WINDOW is 0 — old bytecode deployed?");
  if (maxWin === 0n) problems.push("MAX_DELIVERY_WINDOW is 0 — old bytecode deployed?");
  if (confirmWin === 0n) problems.push("CONFIRM_WINDOW is 0 — old bytecode deployed?");
  if (backstop === 0n) problems.push("DISPUTE_BACKSTOP is 0 — old bytecode deployed?");

  if (problems.length) {
    console.error("\n❌ VERIFICATION FAILED:");
    for (const p of problems) console.error("   -", p);
    process.exit(1);
  }
  console.log("\n✅ All checks passed — hardened contract is live.");
}

main().catch((e) => {
  console.error("verify failed:", e.message || e);
  process.exit(1);
});
