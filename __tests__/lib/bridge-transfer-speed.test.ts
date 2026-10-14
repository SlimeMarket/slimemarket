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

  it("marks exactly the Standard-only source chains", () => {
    // Avalanche Fuji and Polygon Amoy are the Standard-only entries in the list.
    const flagged = [...BALANCE.matchAll(/\{\s*id:\s*'([A-Za-z_]+)'[^}]*standardOnly:\s*true/g)].map(
      (m) => m[1],
    );
    expect(flagged.sort()).toEqual(["Avalanche_Fuji", "Polygon_Amoy_Testnet"]);
  });

  it("downgrades to SLOW for those chains when calling bridge", () => {
    expect(BALANCE).toMatch(/transferSpeed:[\s\S]{0,120}standardOnly[\s\S]{0,40}\?\s*'SLOW'/);
  });
});
