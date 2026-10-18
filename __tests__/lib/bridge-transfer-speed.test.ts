import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * CCTP transfer speed on Standard-Transfer-only source chains.
 *
 * `transferSpeed` defaults to FAST on the SDK side, but Avalanche, Polygon PoS,
 * Sei, XDC and their testnets only support CCTP **Standard** Transfer. Asking for
 * FAST there fails with a Quote API error (`PRE_FINALITY_UNAVAILABLE`, surfaced
 * as HTTP 422) — and it fails on Circle's side, so it reads like "the bridge is
 * broken" rather than "we asked for the wrong speed".
 *
 * Two of the six source chains offered in the UI are Standard-only, and the
 * bridge call did not set `transferSpeed` at all, so bridging from Avalanche
 * Fuji or Polygon Amoy could never succeed.
 *
 * These are source-level assertions, matching the style already used for
 * app/api/me/avatar: the bridge runs in a bundled IIFE against a browser wallet,
 * so there is no runtime seam to unit-test without a chain.
 */

const ENTRY = fs.readFileSync(
  path.join(process.cwd(), "app-kit-bridge/entry.ts"),
  "utf8",
);
const BALANCE = fs.readFileSync(path.join(process.cwd(), "public/balance.jsx"), "utf8");

describe("bridge — transferSpeed is sent for Standard-Transfer-only chains", () => {
  it("the bridge API accepts transferSpeed", () => {
    expect(ENTRY).toMatch(/transferSpeed\?:\s*"FAST"\s*\|\s*"SLOW"/);
  });

  it("forwards it into the SDK call config", () => {
    expect(ENTRY).toMatch(/config:\s*\{\s*transferSpeed\s*\}/);
  });

  it("omits it when not supplied, so FAST stays the default elsewhere", () => {
    // `...(transferSpeed ? {...} : {})` — spreading conditionally, not always.
    expect(ENTRY).toMatch(/\.\.\.\(transferSpeed \?/);
  });

  it("add funds no longer offers a TESTNET source-chain bridge on mainnet", () => {
    // The add-funds Bridge tab used to list Base Sepolia / Fuji / Amoy etc. while
    // the app runs on Arc MAINNET, so "Bridge USDC" could never work. Funding is
    // now external-wallet-first: connect, then deposit to the user's own Arc
    // address. These assertions keep the dead testnet list from coming back.
    expect(BALANCE).not.toMatch(/BRIDGE_SOURCE_CHAINS/);
    expect(BALANCE).not.toMatch(/Base_Sepolia/);
    expect(BALANCE).not.toMatch(/window\.AppKitHelper\.bridge/);
  });

  it("the bridge tab gates on a connected external wallet", () => {
    // "pake external wallet / connect wallet dulu": no wallet connected means
    // only a Connect CTA is shown, never a form that submits a bridge.
    expect(BALANCE).toMatch(/connectExternal/);
    expect(BALANCE).toMatch(/extAddr \?/);
    expect(BALANCE).not.toMatch(/doBridge/);
  });

  it("labels the network as mainnet or testnet, never silently", () => {
    expect(BALANCE).toMatch(/isMainnet/);
    expect(BALANCE).toMatch(/PixBadge color="emerald">\{tr\('balance\.mainnet'/);
  });
});
