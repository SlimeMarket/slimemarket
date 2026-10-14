import fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
const key = env.match(/^CIRCLE_API_KEY=(.*)$/m)[1].replace(/^["']|["']$/g, "").trim();

for (let i = 1; i <= 4; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch("https://api.circle.com/v1/w3s/ping", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    console.log(`try ${i}: http=${r.status} time=${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`try ${i}: ERR ${e.name} ${e.message} (${Date.now() - t0}ms)`);
  }
}

// Also test the endpoint the app actually uses.
for (let i = 1; i <= 2; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch("https://api.circle.com/v1/w3s/users?pageSize=1", {
      headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    console.log(`users try ${i}: http=${r.status} time=${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`users try ${i}: ERR ${e.name} ${e.message} (${Date.now() - t0}ms)`);
  }
}
