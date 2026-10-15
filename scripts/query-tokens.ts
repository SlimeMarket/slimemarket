/**
 * Query Circle for supported tokens on ARC mainnet
 *
 * Usage:
 *   node --env-file=.env.mainnet --import tsx scripts/query-tokens.ts
 */

const apiKey = process.env.CIRCLE_API_KEY;

if (!apiKey) {
  console.error("Missing CIRCLE_API_KEY");
  process.exit(1);
}

async function main() {
  // Try multiple endpoints
  const endpoints = [
    "https://api.circle.com/v1/tokens",
    "https://api.circle.com/v1/w3s/tokens",
    "https://api.circle.com/v1/w3s/wallets/tokens",
  ];

  for (const url of endpoints) {
    console.log(`\nTrying: ${url}`);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await res.text();
      console.log(`  Status: ${res.status}`);
      if (res.ok) {
        const data = JSON.parse(text);
        console.log("  Response:", JSON.stringify(data, null, 2));
      } else {
        console.log("  Error:", text.substring(0, 200));
      }
    } catch (e: any) {
      console.log("  Exception:", e.message);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
