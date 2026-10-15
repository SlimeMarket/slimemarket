/**
 * Query Circle for mainnet USDC token ID and App Kit key.
 *
 * Usage:
 *   node --env-file=.env.mainnet --import tsx scripts/query-circle-config.ts
 */

{
const apiKey = process.env.CIRCLE_API_KEY;
const baseUrl = "https://api.circle.com/v1";

if (!apiKey) {
  console.error("Missing CIRCLE_API_KEY");
  process.exit(1);
}

async function fetchTokens() {
  console.log("=== Querying Circle token list ===\n");
  const res = await fetch(`${baseUrl}/tokens`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.error("Token list failed:", res.status, await res.text());
    return;
  }
  const data = await res.json();
  const tokens = data.data?.tokens || [];

  // Filter for USDC on Arc
  const arcUsdc = tokens.filter(
    (t: any) =>
      t.symbol === "USDC" &&
      (t.blockchain === "ARC" || t.name?.toLowerCase().includes("arc"))
  );

  if (arcUsdc.length === 0) {
    console.log("No USDC on ARC found in token list.");
    console.log("Available tokens:", tokens.map((t: any) => `${t.symbol}@${t.blockchain}`).join(", "));
  } else {
    console.log("USDC on ARC:");
    arcUsdc.forEach((t: any) => {
      console.log(`  Token ID: ${t.id}`);
      console.log(`  Name:     ${t.name}`);
      console.log(`  Symbol:   ${t.symbol}`);
      console.log(`  Chain:    ${t.blockchain}`);
      console.log(`  isNative: ${t.isNative}`);
    });
  }
}

async function fetchAppKitKeys() {
  console.log("\n=== Querying Arc App Kit keys ===\n");
  // Arc App Kit keys are under a different endpoint
  const res = await fetch(`${baseUrl}/arc/appKit/apiKeys`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.error("App Kit keys query failed:", res.status, await res.text());
    console.log("\nYou must manually create an App Kit key in Circle Console:");
    console.log("  Console → Arc App Kit → Keys → Create (Production environment)");
    return;
  }
  const data = await res.json();
  console.log("App Kit keys:", JSON.stringify(data, null, 2));
}

async function main() {
  await fetchTokens();
  await fetchAppKitKeys();
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
}
