import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Cross-chain wallet provisioning.
 *
 * The load-bearing property here is that provisioning is DIFF-BASED. Circle's
 * `createWallet({ blockchains })` creates a wallet for every chain listed and
 * does NOT skip chains the user already has. If we ever pass the full desired
 * set for an existing user, they silently receive a second Arc wallet — and
 * because `pickArcWallet` may then resolve to either address, USDC sent to the
 * other one looks lost. That regression is what most of these tests guard.
 */

const fakeSdk = {
  listWallets: vi.fn(),
  createWallet: vi.fn(),
};

let sdkValue: unknown = fakeSdk;
vi.mock("@/lib/circle/ucw-client", () => ({
  get circleUcwSdk() {
    return sdkValue;
  },
}));

import {
  crossChainPayEnabled,
  desiredSourceBlockchains,
  sourceChainWallets,
  ensureSourceChainWallets,
} from "@/lib/cctp/wallets";

const ORIGINAL = {
  pay: process.env.CROSS_CHAIN_PAY,
  chains: process.env.CROSS_CHAIN_SOURCE_CHAINS,
  arcChainId: process.env.ARC_CHAIN_ID,
};

afterEach(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("CROSS_CHAIN_PAY", ORIGINAL.pay);
  restore("CROSS_CHAIN_SOURCE_CHAINS", ORIGINAL.chains);
  restore("ARC_CHAIN_ID", ORIGINAL.arcChainId);
});

beforeEach(() => {
  sdkValue = fakeSdk;
  for (const fn of Object.values(fakeSdk)) fn.mockReset();
  delete process.env.CROSS_CHAIN_PAY;
  delete process.env.CROSS_CHAIN_SOURCE_CHAINS;
  delete process.env.ARC_CHAIN_ID;
});

function wallet(blockchain: string, address: string, state = "LIVE") {
  return { id: `w-${blockchain}`, address, blockchain, state };
}

describe("crossChainPayEnabled", () => {
  it("is off unless CROSS_CHAIN_PAY=1", () => {
    expect(crossChainPayEnabled()).toBe(false);
    process.env.CROSS_CHAIN_PAY = "0";
    expect(crossChainPayEnabled()).toBe(false);
    process.env.CROSS_CHAIN_PAY = "true";
    expect(crossChainPayEnabled()).toBe(false); // strict: only "1"
    process.env.CROSS_CHAIN_PAY = "1";
    expect(crossChainPayEnabled()).toBe(true);
  });
});

describe("desiredSourceBlockchains", () => {
  it("defaults to every configured source chain", () => {
    expect(desiredSourceBlockchains().sort()).toEqual(
      ["ARB-SEPOLIA", "AVAX-FUJI", "BASE-SEPOLIA", "ETH-SEPOLIA"].sort(),
    );
  });

  it("honours an explicit subset from env", () => {
    process.env.CROSS_CHAIN_SOURCE_CHAINS = "baseSepolia, avalancheFuji";
    expect(desiredSourceBlockchains()).toEqual(["BASE-SEPOLIA", "AVAX-FUJI"]);
  });

  it("throws on an unknown chain instead of silently provisioning a different set", () => {
    process.env.CROSS_CHAIN_SOURCE_CHAINS = "baseSepolia,solana";
    expect(() => desiredSourceBlockchains()).toThrow(/not a CCTP source chain/);
  });
});

describe("sourceChainWallets", () => {
  it("maps wallets onto chains and skips chains with no wallet", () => {
    const out = sourceChainWallets([
      wallet("ARC-TESTNET", "0xarc"),
      wallet("BASE-SEPOLIA", "0xbase"),
      wallet("AVAX-FUJI", "0xavax", "INITIALIZING"),
    ]);

    expect(out.map((w) => w.key).sort()).toEqual(["avalancheFuji", "baseSepolia"]);
    const base = out.find((w) => w.key === "baseSepolia")!;
    expect(base.address).toBe("0xbase");
    expect(base.label).toBe("Base Sepolia");
    expect(base.live).toBe(true);
    // A wallet that has not reached LIVE is surfaced but flagged unusable.
    expect(out.find((w) => w.key === "avalancheFuji")!.live).toBe(false);
  });

  it("returns an empty list when the user has no source-chain wallets", () => {
    expect(sourceChainWallets([wallet("ARC-TESTNET", "0xarc")])).toEqual([]);
  });
});

describe("ensureSourceChainWallets", () => {
  it("issues NO challenge when every source chain already has a wallet", async () => {
    fakeSdk.listWallets.mockResolvedValue({
      data: {
        wallets: [
          wallet("ARC-TESTNET", "0xarc"),
          wallet("BASE-SEPOLIA", "0xbase"),
          wallet("AVAX-FUJI", "0xavax"),
          wallet("ETH-SEPOLIA", "0xeth"),
          wallet("ARB-SEPOLIA", "0xarb"),
        ],
      },
    });

    const res = await ensureSourceChainWallets("tok");

    expect(res.missing).toEqual([]);
    expect(res.challengeId).toBeNull();
    expect(fakeSdk.createWallet).not.toHaveBeenCalled();
  });

  it("requests ONLY the missing chains — never a duplicate Arc wallet", async () => {
    fakeSdk.listWallets.mockResolvedValue({
      data: {
        wallets: [wallet("ARC-TESTNET", "0xarc"), wallet("BASE-SEPOLIA", "0xbase")],
      },
    });
    fakeSdk.createWallet.mockResolvedValue({ data: { challengeId: "chal-1" } });

    const res = await ensureSourceChainWallets("tok");

    expect(res.challengeId).toBe("chal-1");
    // Compare sorted COPIES — `.sort()` mutates, and comparing against a sorted
    // original would silently pass regardless of the real order.
    expect([...res.missing].sort()).toEqual(["ARB-SEPOLIA", "AVAX-FUJI", "ETH-SEPOLIA"].sort());

    const arg = fakeSdk.createWallet.mock.calls[0][0];
    expect([...arg.blockchains].sort()).toEqual([...res.missing].sort());
    expect(arg.blockchains).not.toContain("ARC-TESTNET");
    // Deterministic order (the configured table's order), so the challenge the
    // user sees is always the same.
    expect(arg.blockchains).toEqual(["ETH-SEPOLIA", "AVAX-FUJI", "ARB-SEPOLIA"]);
    expect(arg.userToken).toBe("tok");
    expect(arg.accountType).toBe("EOA");
  });

  it("provisions everything for a user who only has the Arc wallet", async () => {
    fakeSdk.listWallets.mockResolvedValue({ data: { wallets: [wallet("ARC-TESTNET", "0xarc")] } });
    fakeSdk.createWallet.mockResolvedValue({ data: { challengeId: "chal-2" } });

    const res = await ensureSourceChainWallets("tok");

    expect(res.missing).toHaveLength(4);
    expect(fakeSdk.createWallet.mock.calls[0][0].blockchains).not.toContain("ARC-TESTNET");
  });

  it("respects the env-configured subset", async () => {
    process.env.CROSS_CHAIN_SOURCE_CHAINS = "baseSepolia";
    fakeSdk.listWallets.mockResolvedValue({ data: { wallets: [wallet("ARC-TESTNET", "0xarc")] } });
    fakeSdk.createWallet.mockResolvedValue({ data: { challengeId: "chal-3" } });

    const res = await ensureSourceChainWallets("tok");

    expect(res.missing).toEqual(["BASE-SEPOLIA"]);
  });

  it("surfaces a Circle failure as UcwError (no silent success)", async () => {
    // An unmapped Circle code must not swallow the original message.
    fakeSdk.listWallets.mockRejectedValue(Object.assign(new Error("boom"), { code: 999999 }));
    await expect(ensureSourceChainWallets("tok")).rejects.toThrow(/boom/);

    // A known code is translated to the friendly message — also a rejection,
    // never a quiet empty result that the caller would read as "all good".
    fakeSdk.listWallets.mockReset();
    fakeSdk.listWallets.mockRejectedValue(Object.assign(new Error("raw"), { code: 155101 }));
    await expect(ensureSourceChainWallets("tok")).rejects.toThrow(/already exists/);
  });
});
