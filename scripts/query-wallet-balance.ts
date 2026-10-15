/**
 * Query Circle wallet balances via raw API
 *
 * Usage:
 *   node --env-file=.env.mainnet --import tsx scripts/query-wallet-balance.ts
 */

const apiKey = process.env.CIRCLE_API_KEY;
const walletId = process.env.PLATFORM_CIRCLE_WALLET_ID;

if (!apiKey || !walletId) {
  console.error("Missing CIRCLE_API_KEY or PLATFORM_CIRCLE_WALLET_ID");
  process.exit(1);
}

async function main() {
  console.log("=== Querying wallet balances ===\n");

  // Try raw API call
  const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${walletId}/balances`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    console.error("Balance query failed:", res.status, await res.text());
    return;
  }

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
