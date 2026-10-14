/**
 * Test wallets for Arc Testnet.
 *
 * The E2E script used to generate throwaway keys on every run, which is useless
 * for faucet funding (the address changed each time). This creates TWO PERSISTENT
 * EOAs under .secrets/ so they can be funded once and reused:
 *
 *   .secrets/test-buyer.key   → pays for the deal, confirms receipt
 *   .secrets/test-seller.key  → deposits collateral, marks delivered
 *
 * Also prints any Circle UCW test users found under .secrets/ (those are
 * app-level identities whose keys live with Circle, not here).
 *
 * Usage: node --env-file=.env.local --import tsx scripts/test-wallets.ts
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, http, formatUnits, type Hex } from "viem";

const ROOT = resolve(import.meta.dirname, "..");
const SECRETS = resolve(ROOT, ".secrets");
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const USDC = process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS as Hex | undefined;

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Load a key from .secrets/<name>.key, creating it on first use. */
function loadOrCreate(name: string): { key: Hex; created: boolean } {
  const file = resolve(SECRETS, `${name}.key`);
  if (existsSync(file)) {
    return { key: readFileSync(file, "utf8").trim() as Hex, created: false };
  }
  const key = generatePrivateKey();
  writeFileSync(file, key + "\n", { mode: 0o600 });
  return { key, created: true };
}

async function main() {
  const client = createPublicClient({ transport: http(RPC) });

  const roles = [
    { name: "test-buyer", label: "Buyer ", note: "funds the deal, confirms receipt" },
    { name: "test-seller", label: "Seller", note: "deposits collateral, marks delivered" },
  ];

  console.log("=== Persistent test wallets (Arc Testnet) ===\n");

  const rows: Array<{ label: string; address: string; native: bigint; erc20: bigint }> = [];

  for (const r of roles) {
    const { key, created } = loadOrCreate(r.name);
    const acct = privateKeyToAccount(key);
    const native = await client.getBalance({ address: acct.address });
    const erc20 = USDC
      ? await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] })
      : 0n;
    rows.push({ label: r.label, address: acct.address, native, erc20 });
    console.log(`${r.label}  ${acct.address}`);
    console.log(`         ${r.note}`);
    console.log(`         file: .secrets/${r.name}.key ${created ? "(newly created)" : "(already exists)"}`);
    console.log(`         balance: ${formatUnits(native, 18)} USDC`);
    console.log("");
  }

  // ---- Circle UCW test users (app-level identities, keys held by Circle) ----
  console.log("--- Circle UCW test users found in .secrets/ ---");
  let found = 0;
  for (const f of readdirSync(SECRETS)) {
    if (!f.endsWith(".json")) continue;
    try {
      const o = JSON.parse(readFileSync(resolve(SECRETS, f), "utf8")) as {
        walletAddress?: string; email?: string;
      };
      if (o.walletAddress) {
        const bal = await client.getBalance({ address: o.walletAddress as Hex });
        console.log(`  ${o.walletAddress}  (${f})`);
        console.log(`      email: ${o.email ?? "?"}  |  balance: ${formatUnits(bal, 18)} USDC`);
        found++;
      }
    } catch {
      /* not a wallet artifact */
    }
  }
  if (!found) console.log("  (none)");

  console.log("\n--- Faucet ---");
  console.log("  https://faucet.circle.com  →  select network 'Arc Testnet'");
  console.log("\nNote: on Arc, USDC is NATIVE — a single faucet drip covers gas + ERC-20 balance.");
}

main().catch((e) => {
  console.error("failed:", e.message || e);
  process.exit(1);
});
