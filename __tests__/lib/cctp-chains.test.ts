import { describe, expect, it, vi, afterEach } from "vitest";
import { getAddress, isAddress } from "viem";

/**
 * The CCTP source-chain table is money-touching config: a wrong domain sends
 * USDC into the void, and a wrong TokenMessenger address reverts on-chain.
 * These assertions pin the values that were read out of
 * `@circle-fin/provider-cctp-v2` so a future edit cannot silently drift.
 *
 * The module reads ARC_CHAIN_ID at import time, so the mainnet cases use
 * `vi.resetModules()` + dynamic import rather than mutating a constant.
 */

// First import of the viem-backed chain module pulls in a large dependency
// graph; a cold run has been observed at ~7s, well past vitest's 5s default.
vi.setConfig({ testTimeout: 60_000 });

const ORIGINAL_CHAIN_ID = process.env.ARC_CHAIN_ID;

afterEach(() => {
  if (ORIGINAL_CHAIN_ID === undefined) delete process.env.ARC_CHAIN_ID;
  else process.env.ARC_CHAIN_ID = ORIGINAL_CHAIN_ID;
  vi.resetModules();
});

async function load(chainId?: string) {
  if (chainId === undefined) delete process.env.ARC_CHAIN_ID;
  else process.env.ARC_CHAIN_ID = chainId;
  vi.resetModules();
  return import("@/lib/cctp/chains");
}

describe("cctp/chains — testnet (default)", () => {
  it("exposes the four source chains with verified CCTP domains", async () => {
    const { CCTP_SOURCE_CHAINS } = await load();

    expect(Object.keys(CCTP_SOURCE_CHAINS).sort()).toEqual(
      ["arbitrumSepolia", "avalancheFuji", "baseSepolia", "ethereumSepolia"].sort(),
    );

    // Domains are the single most dangerous value here — a wrong one burns funds.
    expect(CCTP_SOURCE_CHAINS.ethereumSepolia.cctpDomain).toBe(0);
    expect(CCTP_SOURCE_CHAINS.avalancheFuji.cctpDomain).toBe(1);
    expect(CCTP_SOURCE_CHAINS.arbitrumSepolia.cctpDomain).toBe(3);
    expect(CCTP_SOURCE_CHAINS.baseSepolia.cctpDomain).toBe(6);
  });

  it("uses the TESTNET CCTP v2 tier addresses", async () => {
    const { CCTP_TOKEN_MESSENGER_V2, CCTP_MESSAGE_TRANSMITTER_V2 } = await load();

    expect(CCTP_TOKEN_MESSENGER_V2.toLowerCase()).toBe(
      "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa",
    );
    expect(CCTP_MESSAGE_TRANSMITTER_V2.toLowerCase()).toBe(
      "0xe737e5cebeeba77efe34d4aa090756590b1ce275",
    );
    // CCTP v2 derives both from one factory but they are NOT the same contract.
    expect(CCTP_TOKEN_MESSENGER_V2).not.toBe(CCTP_MESSAGE_TRANSMITTER_V2);
  });

  it("carries the verified USDC + chain ids per chain", async () => {
    const { CCTP_SOURCE_CHAINS } = await load();

    expect(CCTP_SOURCE_CHAINS.ethereumSepolia.chainId).toBe(11155111);
    expect(CCTP_SOURCE_CHAINS.avalancheFuji.chainId).toBe(43113);
    expect(CCTP_SOURCE_CHAINS.arbitrumSepolia.chainId).toBe(421614);
    expect(CCTP_SOURCE_CHAINS.baseSepolia.chainId).toBe(84532);

    expect(CCTP_SOURCE_CHAINS.baseSepolia.usdc.toLowerCase()).toBe(
      "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    );
    expect(CCTP_SOURCE_CHAINS.avalancheFuji.usdc.toLowerCase()).toBe(
      "0x5425890298aed601595a70ab815c96711a31bc65",
    );
  });

  it("points at the sandbox attestation host and Arc domain 26", async () => {
    const { IRIS_API_BASE, ARC_CCTP } = await load();

    expect(IRIS_API_BASE).toBe("https://iris-api-sandbox.circle.com");
    // Domain 26 on BOTH Arc testnet and mainnet.
    expect(ARC_CCTP.domain).toBe(26);
  });

  it("marks every testnet source chain standard-only", async () => {
    const { CCTP_SOURCE_CHAINS } = await load();
    for (const c of Object.values(CCTP_SOURCE_CHAINS)) {
      expect(c.standardOnly, `${c.key} should be standard-only`).toBe(true);
    }
  });
});

describe("cctp/chains — mainnet", () => {
  it("switches to the MAINNET tier addresses and production Iris", async () => {
    const { CCTP_TOKEN_MESSENGER_V2, CCTP_MESSAGE_TRANSMITTER_V2, IRIS_API_BASE } = await load(
      "5042",
    );

    expect(CCTP_TOKEN_MESSENGER_V2.toLowerCase()).toBe(
      "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
    );
    expect(CCTP_MESSAGE_TRANSMITTER_V2.toLowerCase()).toBe(
      "0x81d40f21f12a8f0e3252bccb954d722d4c464b64",
    );
    expect(IRIS_API_BASE).toBe("https://iris-api.circle.com");
  });

  it("exposes mainnet source chains (no testnet leakage)", async () => {
    const { CCTP_SOURCE_CHAINS } = await load("5042");

    expect(Object.keys(CCTP_SOURCE_CHAINS).sort()).toEqual(
      ["arbitrum", "avalanche", "base", "ethereum"].sort(),
    );
    expect(CCTP_SOURCE_CHAINS.base.usdc.toLowerCase()).toBe(
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    );
    // Domains are network-independent.
    expect(CCTP_SOURCE_CHAINS.base.cctpDomain).toBe(6);
    expect(CCTP_SOURCE_CHAINS.ethereum.cctpDomain).toBe(0);
  });
});

describe("cctp/chains — helpers", () => {
  it("cctpSourceChain returns null for unknown / empty keys instead of throwing", async () => {
    const { cctpSourceChain } = await load();
    expect(cctpSourceChain("nope")).toBeNull();
    expect(cctpSourceChain("")).toBeNull();
    expect(cctpSourceChain(null)).toBeNull();
    expect(cctpSourceChain(undefined)).toBeNull();
    expect(cctpSourceChain("baseSepolia")?.key).toBe("baseSepolia");
  });

  it("every entry has a valid, checksummed USDC address and an https RPC", async () => {
    const { CCTP_SOURCE_CHAINS } = await load();
    for (const c of Object.values(CCTP_SOURCE_CHAINS)) {
      expect(isAddress(c.usdc), `${c.key} usdc`).toBe(true);
      // getAddress returns the EIP-55 checksummed form; equality proves the
      // stored literal is already correctly checksummed (viem would throw or
      // differ otherwise, and a mis-cased literal is a copy-paste smell).
      expect(getAddress(c.usdc)).toBe(c.usdc);
      expect(c.rpcUrl.startsWith("https://"), `${c.key} rpc must be https`).toBe(true);
      expect(c.circleBlockchain.length).toBeGreaterThan(0);
    }
  });

  it("toMintRecipient left-pads to bytes32 and rejects junk", async () => {
    const { toMintRecipient } = await load();

    const padded = toMintRecipient("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(padded).toHaveLength(66); // 0x + 64 hex chars
    expect(padded.startsWith("0x000000000000000000000000")).toBe(true);
    // `pad` preserves the EIP-55 checksum casing, so compare case-insensitively
    // — the point of the assertion is the 12-byte left pad + the right address.
    expect(padded.toLowerCase().endsWith("036cbd53842c5426634e7929541ec2318f3dcf7e")).toBe(true);

    expect(() => toMintRecipient("not-an-address")).toThrow(/not a valid EVM address/);
    expect(() => toMintRecipient("0x1234")).toThrow(/not a valid EVM address/);
  });
});
