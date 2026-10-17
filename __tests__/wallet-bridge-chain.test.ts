import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * The external-wallet checkout path runs in `public/wallet-bridge.js`, a STATIC
 * bundle built from `wallet-bridge/entry.tsx`. It cannot read process.env, so
 * the network used to be hardcoded — and it stayed hardcoded to Arc Testnet
 * (5042002) with `https://rpc.testnet.arc.network` after the app went mainnet.
 *
 * Result on a live mainnet deploy, when buying with an external wallet:
 *
 *   Request Arguments: chain: Arc Testnet (id: 5042002)
 *   HTTP request failed. URL: https://rpc.testnet.arc.network/
 *   {"method":"eth_getTransactionCount", ...} → Failed to fetch
 *
 * which the wallet surfaces as "User rejected the request". The chain now comes
 * from `/config.js` (server env → browser), so these guards pin that wiring:
 * if the chain is ever hardcoded again, or /config.js stops serving it, this
 * test fails instead of the checkout.
 */

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * Strip comments before asserting "no testnet literal in the code". The bug is
 * documented in comments (that's the point of the comments), so only actual
 * executable/JSX text should be checked. `https://` is preserved because a
 * naive `//` strip would eat RPC URLs inside string literals.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i === -1 || line[i - 1] === ":") return line;
      return line.slice(0, i);
    })
    .join("\n");
}

const TESTNET_CHAIN_ID = "5042002";
const DEAD_TESTNET_RPC = "rpc.testnet.arc.network";

describe("wallet-bridge resolves the chain at runtime", () => {
  const entry = read("wallet-bridge/entry.tsx");
  const entryCode = stripComments(entry);

  it("does not hardcode the testnet chain id", () => {
    expect(entryCode).not.toContain(TESTNET_CHAIN_ID);
  });

  it("does not hardcode the retired testnet RPC host", () => {
    expect(entryCode).not.toContain(DEAD_TESTNET_RPC);
  });

  it("reads the chain from the server-served /config.js", () => {
    expect(entryCode).toMatch(/SLIME_CONFIG/);
    expect(entryCode).toMatch(/SLIME_CONFIG[\s\S]{0,80}\.chain/);
  });

  it("falls back to Arc MAINNET, never to a testnet", () => {
    const fallback = entryCode.slice(entryCode.indexOf("FALLBACK_CHAIN"));
    expect(fallback).toContain("rpc.mainnet.arc.io");
    expect(fallback).toContain("5042");
  });

  it("can switch the wallet and add the chain when unknown", () => {
    expect(entryCode).toContain("wallet_addEthereumChain");
    expect(entryCode).toMatch(/switchChainAsync/);
  });
});

describe("/config.js exposes the chain the server is actually on", () => {
  const route = stripComments(read("app/config.js/route.ts"));

  it("serves a chain block derived from lib/arc (env), not literals", () => {
    expect(route).toMatch(/chain:\s*\{/);
    expect(route).toContain("ARC_CHAIN_ID");
    expect(route).toContain("ARC_RPC_URL");
    expect(route).not.toContain(TESTNET_CHAIN_ID);
    expect(route).not.toContain(DEAD_TESTNET_RPC);
  });
});

describe("the shipped bundle matches the source", () => {
  const bundlePath = resolve(ROOT, "public/wallet-bridge.js");

  it("stamps the build so a stale cached bundle is identifiable", () => {
    expect(read("wallet-bridge/entry.tsx")).toContain("__SLIME_WB_BUILD");
  });

  it("does not hardcode the chain name in the UI shell", () => {
    // The sidebar said "Arc Testnet" on a mainnet deploy — the label must come
    // from SLIME_CONFIG.chain, otherwise it hides which network is live.
    const app = stripComments(read("public/app.jsx"));
    expect(app).not.toMatch(/>\s*Arc Testnet\s*</);
    expect(app).toContain("SLIME_CONFIG");
  });

  it("contains no testnet chain id", () => {
    if (!existsSync(bundlePath)) return; // not built in this checkout
    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle).not.toContain(TESTNET_CHAIN_ID);
    expect(bundle).not.toContain(DEAD_TESTNET_RPC);
    expect(bundle).toContain("rpc.mainnet.arc.io");
  });

  it("is referenced with a cache-busting query in index.html", () => {
    // public/ is static: nginx + the browser cache it hard, so an unversioned
    // <script src> keeps serving the old bundle after a rebuild.
    const html = read("public/index.html");
    const tag = html.match(/<script src="\/wallet-bridge\.js([^"]*)"><\/script>/);
    expect(tag, "wallet-bridge.js script tag not found").toBeTruthy();
    expect(tag![1]).toMatch(/^\?v=\d{8}/);
  });
});
