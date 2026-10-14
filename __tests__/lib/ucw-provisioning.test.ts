import { describe, it, expect } from "vitest";

import {
  pickArcWallet,
  pickWalletForChain,
  missingChains,
  decideProvisioning,
} from "@/lib/circle/ucw-provisioning";

// ---------------------------------------------------------------------------
// pickArcWallet — choose the ARC-TESTNET wallet to persist locally.
// Preference order: LIVE ARC-TESTNET > any ARC-TESTNET > null.
// ---------------------------------------------------------------------------
describe("pickArcWallet", () => {
  it("returns null for an empty list", () => {
    expect(pickArcWallet([])).toBeNull();
  });

  it("returns null when no ARC-TESTNET wallet exists", () => {
    expect(
      pickArcWallet([
        { address: "0xa", blockchain: "ETH-SEPOLIA", state: "LIVE" },
        { address: "0xb", blockchain: "SOL-MAINNET", state: "INITIAL" },
      ]),
    ).toBeNull();
  });

  it("picks the only ARC-TESTNET wallet", () => {
    const w = { address: "0xa", blockchain: "ARC-TESTNET", state: "LIVE", id: "w1" };
    expect(pickArcWallet([w])).toBe(w);
  });

  it("prefers state LIVE over non-LIVE ARC-TESTNET wallets", () => {
    const initial = { address: "0xa", blockchain: "ARC-TESTNET", state: "INITIAL", id: "w1" };
    const live = { address: "0xb", blockchain: "ARC-TESTNET", state: "LIVE", id: "w2" };
    expect(pickArcWallet([initial, live])).toBe(live);
    expect(pickArcWallet([live, initial])).toBe(live);
  });

  it("falls back to the first ARC-TESTNET wallet when none is LIVE", () => {
    const a = { address: "0xa", blockchain: "ARC-TESTNET", state: "INITIAL", id: "w1" };
    const b = { address: "0xb", blockchain: "ARC-TESTNET", state: "BACKUPING", id: "w2" };
    expect(pickArcWallet([a, b])).toBe(a);
  });

  it("handles missing/undefined state as non-LIVE", () => {
    const live = { address: "0xb", blockchain: "ARC-TESTNET", state: "LIVE", id: "w2" };
    const noState = { address: "0xa", blockchain: "ARC-TESTNET", id: "w1" };
    expect(pickArcWallet([noState as any, live])).toBe(live);
  });
});

// ---------------------------------------------------------------------------
// pickWalletForChain — generic version of pickArcWallet for source chains.
// ---------------------------------------------------------------------------
describe("pickWalletForChain", () => {
  const base = { address: "0xb", blockchain: "BASE-SEPOLIA", state: "INITIAL", id: "w1" };
  const baseLive = { address: "0xc", blockchain: "BASE-SEPOLIA", state: "LIVE", id: "w2" };

  it("returns null when the chain has no wallet", () => {
    expect(pickWalletForChain([{ address: "0xa", blockchain: "ARC-TESTNET" }], "BASE-SEPOLIA")).toBeNull();
  });

  it("prefers LIVE over non-LIVE", () => {
    expect(pickWalletForChain([base, baseLive], "BASE-SEPOLIA")).toBe(baseLive);
    expect(pickWalletForChain([baseLive, base], "BASE-SEPOLIA")).toBe(baseLive);
  });

  it("falls back to the first match when none is LIVE", () => {
    expect(pickWalletForChain([base], "BASE-SEPOLIA")).toBe(base);
  });

  it("matches case-insensitively (Circle returns upper-case)", () => {
    expect(pickWalletForChain([base], "base-sepolia")).toBe(base);
    expect(pickWalletForChain([{ address: "0xa", blockchain: "base-sepolia" }], "BASE-SEPOLIA")).toBeTruthy();
  });

  it("ignores wallets with a missing blockchain field", () => {
    const live = { address: "0xc", blockchain: "BASE-SEPOLIA", state: "LIVE", id: "w2" };
    expect(pickWalletForChain([{ address: "0xa" } as any, live], "BASE-SEPOLIA")).toBe(live);
  });
});

// ---------------------------------------------------------------------------
// missingChains — the guard against duplicate wallets.

// Circle's createWallet() creates a wallet for EVERY chain in the list; it does
// not skip chains the user already has. Passing the full desired set for an
// existing user would hand them a second Arc wallet, and pickArcWallet could
// then resolve to either one — so funds sent to the other address look lost.
// ---------------------------------------------------------------------------
describe("missingChains", () => {
  it("returns everything when nothing exists yet", () => {
    expect(missingChains([], ["BASE-SEPOLIA", "AVAX-FUJI"])).toEqual(["BASE-SEPOLIA", "AVAX-FUJI"]);
  });

  it("returns an empty list when everything already exists", () => {
    expect(missingChains(["BASE-SEPOLIA", "AVAX-FUJI"], ["BASE-SEPOLIA", "AVAX-FUJI"])).toEqual([]);
  });

  it("returns ONLY the genuinely missing chains (never the existing ones)", () => {
    const missing = missingChains(
      ["ARC-TESTNET", "BASE-SEPOLIA"],
      ["BASE-SEPOLIA", "AVAX-FUJI", "ETH-SEPOLIA"],
    );
    expect(missing).toEqual(["AVAX-FUJI", "ETH-SEPOLIA"]);
    expect(missing).not.toContain("BASE-SEPOLIA");
  });

  it("is case-insensitive so Circle's upper-case ids match lower-case callers", () => {
    expect(missingChains(["base-sepolia"], ["BASE-SEPOLIA"])).toEqual([]);
    expect(missingChains(["BASE-SEPOLIA"], ["base-sepolia"])).toEqual([]);
  });

  it("preserves the order of `desired` for a deterministic challenge", () => {
    expect(missingChains([], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("dedupes repeated entries in `desired`", () => {
    expect(missingChains([], ["BASE-SEPOLIA", "base-sepolia"])).toEqual(["BASE-SEPOLIA"]);
  });

  it("tolerates null/undefined/empty entries on both sides", () => {
    expect(missingChains([null, undefined, "", "BASE-SEPOLIA"], [null, undefined, "", "BASE-SEPOLIA"])).toEqual([]);
    expect(missingChains([], [null, undefined, "", "BASE-SEPOLIA"])).toEqual(["BASE-SEPOLIA"]);
  });

  it("is idempotent — running it on its own output yields nothing more", () => {
    const desired = ["BASE-SEPOLIA", "AVAX-FUJI"];
    const first = missingChains(["ARC-TESTNET"], desired);
    const existingNow = ["ARC-TESTNET", ...first];
    expect(missingChains(existingNow, desired)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// decideProvisioning — what to do for EVERY real session at login/boot
// (the walletProvisioned gate was removed; legacy accounts with a
// wallet but no PIN must be offered the pin-only challenge):
//   'full-challenge'        → PIN UNSET + no wallet (createUserPinWithWallets)
//   'pin-only-challenge'    → PIN UNSET + wallet exists (createUserPin)
//   'wallet-only-challenge' → PIN ENABLED + no wallet (createWallet)
//   'done'                  → PIN ENABLED + wallet exists → flip flag only
//   'locked'                → PIN LOCKED → restore flow is separate
//   'skip'                  → unknown status → never block login
// ---------------------------------------------------------------------------
describe("decideProvisioning", () => {
  it("full-challenge when PIN is UNSET and no wallet", () => {
    expect(decideProvisioning({ pinStatus: "UNSET", hasWallet: false })).toBe("full-challenge");
  });

  it("pin-only-challenge when PIN is UNSET but a wallet already exists (legacy account)", () => {
    // The Rimuru case: wallet created pre-PIN era. Set the PIN without
    // creating another wallet.
    expect(decideProvisioning({ pinStatus: "UNSET", hasWallet: true })).toBe("pin-only-challenge");
  });

  it("wallet-only-challenge when PIN is ENABLED but no wallet exists", () => {
    expect(decideProvisioning({ pinStatus: "ENABLED", hasWallet: false })).toBe("wallet-only-challenge");
  });

  it("is done when PIN is ENABLED and a wallet exists", () => {
    expect(decideProvisioning({ pinStatus: "ENABLED", hasWallet: true })).toBe("done");
  });

  it("locked when PIN is LOCKED (restore flow is a separate concern)", () => {
    expect(decideProvisioning({ pinStatus: "LOCKED", hasWallet: false })).toBe("locked");
    expect(decideProvisioning({ pinStatus: "LOCKED", hasWallet: true })).toBe("locked");
  });

  it("treats unknown pinStatus as skip (never block login)", () => {
    expect(decideProvisioning({ pinStatus: undefined, hasWallet: false })).toBe("skip");
    expect(decideProvisioning({ pinStatus: "WEIRD" as any, hasWallet: true })).toBe("skip");
  });
});

