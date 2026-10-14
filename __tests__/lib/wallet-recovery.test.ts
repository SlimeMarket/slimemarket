import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildRecoveryMessage,
  verifyRecoverySignature,
  NONCE_TTL_MS,
  RECOVERY_PURPOSES,
  type RecoveryPurpose,
} from "@/lib/auth/recovery";

// wallet-based (EOA) recovery: pure helpers.

// The message + signature layer is the security boundary for account recovery
// (it proves EOA ownership without any email), so it is pinned hard here:
// domain binding, address binding, nonce binding, and strict rejection of
// anything malformed.

const DOMAIN = "https://slimemarket.xyz";
const NONCE = "b1946ac92492d2347c6235b4d2611184";
const ISSUED = "2026-09-16T10:00:00.000Z";
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

function msgInput(purpose: RecoveryPurpose = RECOVERY_PURPOSES.LOGIN) {
  return { domain: DOMAIN, address: account.address, nonce: NONCE, issuedAt: ISSUED, purpose };
}

const account = privateKeyToAccount(TEST_KEY);
const other = privateKeyToAccount(OTHER_KEY);

describe("buildRecoveryMessage", () => {
  it("is deterministic and contains every bound field", () => {
    const m1 = buildRecoveryMessage(msgInput());
    const m2 = buildRecoveryMessage(msgInput());
    expect(m1).toBe(m2);
    expect(m1).toContain("SlimeMarket wallet recovery");
    expect(m1).toContain(`Domain: ${DOMAIN}`);
    expect(m1).toContain(`Address: ${account.address.toLowerCase()}`);
    expect(m1).toContain(`Purpose: ${RECOVERY_PURPOSES.LOGIN}`);
    expect(m1).toContain(`Nonce: ${NONCE}`);
    expect(m1).toContain(`Issued At: ${ISSUED}`);
  });

  it("normalizes the address to lowercase (checksum variants sign the same message)", () => {
    const lower = buildRecoveryMessage({ ...msgInput(), address: account.address.toLowerCase() });
    const checksummed = buildRecoveryMessage({ ...msgInput(), address: account.address });
    expect(lower).toBe(checksummed);
  });

  it("is domain-bound — a signature for another domain cannot validate ours", () => {
    const ours = buildRecoveryMessage(msgInput());
    const evil = buildRecoveryMessage({ ...msgInput(), domain: "https://evil.example" });
    expect(ours).not.toBe(evil);
  });

  it("differs by purpose and nonce (replay / cross-flow separation)", () => {
    const login = buildRecoveryMessage(msgInput(RECOVERY_PURPOSES.LOGIN));
    const link = buildRecoveryMessage(msgInput(RECOVERY_PURPOSES.LINK));
    const otherNonce = buildRecoveryMessage({ ...msgInput(), nonce: "ffeeddccbbaa99887766554433221100" });
    expect(login).not.toBe(link);
    expect(login).not.toBe(otherNonce);
  });
});

describe("verifyRecoverySignature", () => {
  it("accepts a real signature from the matching EOA", async () => {
    const message = buildRecoveryMessage(msgInput());
    const signature = await account.signMessage({ message });
    await expect(
      verifyRecoverySignature({ address: account.address, message, signature }),
    ).resolves.toBe(true);
  });

  it("accepts when the address is presented checksummed or lowercased", async () => {
    const message = buildRecoveryMessage(msgInput());
    const signature = await account.signMessage({ message });
    await expect(
      verifyRecoverySignature({ address: account.address.toLowerCase(), message, signature }),
    ).resolves.toBe(true);
  });

  it("rejects a signature produced by a different wallet", async () => {
    const message = buildRecoveryMessage(msgInput());
    const signature = await other.signMessage({ message });
    await expect(
      verifyRecoverySignature({ address: account.address, message, signature }),
    ).resolves.toBe(false);
  });

  it("rejects a tampered message (signature no longer matches content)", async () => {
    const message = buildRecoveryMessage(msgInput());
    const signature = await account.signMessage({ message });
    const tampered = buildRecoveryMessage({ ...msgInput(), nonce: "00000000000000000000000000000000" });
    await expect(
      verifyRecoverySignature({ address: account.address, message: tampered, signature }),
    ).resolves.toBe(false);
  });

  it("rejects malformed input instead of throwing", async () => {
    const message = buildRecoveryMessage(msgInput());
    const signature = await account.signMessage({ message });
    await expect(verifyRecoverySignature({ address: "0xnot-an-address", message, signature })).resolves.toBe(false);
    await expect(verifyRecoverySignature({ address: account.address, message, signature: "0xdeadbeef" })).resolves.toBe(false);
    await expect(verifyRecoverySignature({ address: "", message, signature })).resolves.toBe(false);
    await expect(verifyRecoverySignature({ address: account.address, message: "", signature })).resolves.toBe(false);
  });
});

describe("recovery constants", () => {
  it("nonce TTL is 10 minutes", () => {
    expect(NONCE_TTL_MS).toBe(10 * 60 * 1000);
  });
  it("has the two expected purposes", () => {
    expect(Object.values(RECOVERY_PURPOSES).sort()).toEqual(["link_wallet", "recovery_login"]);
  });
});
