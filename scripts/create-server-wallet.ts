/**
 * Creates the platform wallet set + one SCA DCW on ARC-TESTNET and writes its
 * ids/address into .env.local.
 *
 * NOT idempotent by nature: every run creates a NEW wallet set + wallet,
 * so re-running accumulates orphaned wallets on the Circle account. A guard now
 * refuses when PLATFORM_CIRCLE_WALLET_ID is already set, unless --force.
 *
 * This is the ONLY script that should create the platform wallet. The two older
 * alternatives (register-entity.ts, fresh-entity-wallet-setup.ts) were DELETED
 * because both registered a brand-new entity secret — which invalidates the one
 * already registered in the Circle Console — and one of them targeted a host that
 * does not resolve.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/create-server-wallet.ts
 *   node --env-file=.env.local --import tsx scripts/create-server-wallet.ts --force
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey || !entitySecret) {
  console.error(
    "CIRCLE_API_KEY & CIRCLE_ENTITY_SECRET are required in .env.local.\n" +
    "The entity secret must be the one ALREADY registered in Circle Console — do not create a new one.",
  );
  process.exit(1);
}

const BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN ?? "ARC-TESTNET";
const SECRETS_DIR = ".secrets";
const ENV_PATH = ".env.local";
const FORCE = process.argv.includes("--force");

async function main() {
  // idempotency guard. Without it, every run mints another wallet set +
  // wallet on the Circle account, leaving orphans that are never cleaned up.
  const existingEnv = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const existingWalletId = (existingEnv.match(/^PLATFORM_CIRCLE_WALLET_ID=(.*)$/m)?.[1] ?? "").trim();
  if (existingWalletId && !FORCE) {
    console.error(
      "\nPLATFORM_CIRCLE_WALLET_ID is already set in .env.local:\n" +
      `  ${existingWalletId}\n\n` +
      "Refusing to create ANOTHER wallet (each run leaves an orphaned wallet set on\n" +
      "the Circle account). Clear that line first if you really want a new wallet,\n" +
      "or pass --force to override.\n",
    );
    process.exit(1);
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey: apiKey!, entitySecret: entitySecret! });

  const walletSetResp = await client.createWalletSet({ name: "SlimeMarket Server" });
  const walletSetId = walletSetResp.data?.walletSet?.id;
  if (!walletSetId) {
    console.error("Failed to create wallet set:", JSON.stringify(walletSetResp.data));
    process.exit(1);
  }
  console.log(`[OK] Wallet set: ${walletSetId}`);

  const walletResp = await client.createWallets({
    walletSetId,
    blockchains: [BLOCKCHAIN as never],
    count: 1,
    accountType: "SCA", // Changed from EOA to SCA for Gas Station support!
  });

  const w = walletResp.data?.wallets?.[0];
  if (!w?.id || !w.address) {
    console.error("Failed to create wallet:", JSON.stringify(walletResp.data));
    process.exit(1);
  }
  console.log(`[OK] Wallet ID: ${w.id}`);
  console.log(`      Address : ${w.address}`);

  const walletExport = {
    walletSetId,
    walletId: w.id,
    address: w.address,
    blockchain: BLOCKCHAIN,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(`${SECRETS_DIR}/server-wallet.json`, JSON.stringify(walletExport, null, 2));

  let updated = existingEnv;

  if (!/^CIRCLE_WALLET_SET_ID=/m.test(updated)) {
    updated += `\nCIRCLE_WALLET_SET_ID=${walletSetId}\n`;
  } else {
    updated = updated.replace(/^CIRCLE_WALLET_SET_ID=.*/m, `CIRCLE_WALLET_SET_ID=${walletSetId}`);
  }

  if (!/^PLATFORM_CIRCLE_WALLET_ID=/m.test(updated)) {
    updated += `PLATFORM_CIRCLE_WALLET_ID=${w.id}\n`;
  } else {
    updated = updated.replace(/^PLATFORM_CIRCLE_WALLET_ID=.*/m, `PLATFORM_CIRCLE_WALLET_ID=${w.id}`);
  }

  const agentAddrLine = `NEXT_PUBLIC_AGENT_WALLET_ADDRESS=${w.address}`;
  const agentIdLine = `NEXT_PUBLIC_AGENT_WALLET_ID=${w.id}`;

  if (!/^NEXT_PUBLIC_AGENT_WALLET_ID=/m.test(updated)) {
    updated += `${agentIdLine}\n${agentAddrLine}\n`;
  } else {
    updated = updated
      .replace(/^NEXT_PUBLIC_AGENT_WALLET_ID=.*/m, agentIdLine)
      .replace(/^NEXT_PUBLIC_AGENT_WALLET_ADDRESS=.*/m, agentAddrLine);
  }

  writeFileSync(ENV_PATH, updated);

  console.log("[OK] .env.local updated: CIRCLE_WALLET_SET_ID, PLATFORM_CIRCLE_WALLET_ID, NEXT_PUBLIC_AGENT_WALLET_*");
  console.log(`      Backup -> ${SECRETS_DIR}/server-wallet.json`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
