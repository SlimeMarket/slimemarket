import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import {
  splitPermitSignature,
  buildEoaPermitPayload,
  readUsdcPermitInfo,
  resolveConfirmPayer,
  resolvePrepareGateTarget,
  verifyUsdcPermitSignature,
  PERMIT_TYPES,
  PERMIT_PAYLOAD_TTL_SECONDS,
} from "@/lib/order/permit-checkout";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { shouldBypassOnChainBalanceGate } from "@/lib/wallet/onchain-funding";
import { CheckoutConfirmBodySchema, CheckoutPrepareBodySchema } from "@/lib/schemas";
import { ARC_CHAIN_ID, ARC_USDC_CONTRACT } from "@/lib/arc";

/**
 * .D — EOA external-wallet checkout (EIP-2612 permit, gasless primary).
 *
 * Contract facts (MarketEscrow.sol L115-134):
 *   createOrderFor(buyer, seller, amount, buyerFee, deadline, v, r, s)
 *   pulls total = amount + buyerFee from buyer via permit → the permit's
 *   `value` MUST cover amount + buyerFee.
 */

const OWNER = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2cfb1c34b5afd797948a5716de422128df3d1553";

describe("splitPermitSignature — 65-byte hex sig → { v, r, s }", () => {
  // r = first 32 bytes, s = next 32 bytes, v = last byte (EIP-2612 layout).
  const R = "0x" + "ab".repeat(32);
  const S = "0x" + "cd".repeat(32);
  const SIG = R + S.slice(2) + "1c"; // v = 0x1c = 28

  it("round-trips a well-formed 65-byte signature", () => {
    const { v, r, s } = splitPermitSignature(SIG);
    expect(r).toBe(R);
    expect(s).toBe(S);
    expect(v).toBe(28);
  });

  it("handles v = 27 (0x1b)", () => {
    const sig = R + S.slice(2) + "1b";
    expect(splitPermitSignature(sig).v).toBe(27);
  });

  it("rejects missing 0x prefix", () => {
    expect(() => splitPermitSignature(SIG.slice(2))).toThrow();
  });

  it("rejects wrong length", () => {
    expect(() => splitPermitSignature(SIG.slice(0, -2))).toThrow();
    expect(() => splitPermitSignature(SIG + "00")).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => splitPermitSignature("0x" + "zz" + SIG.slice(4))).toThrow();
  });
});

describe("buildEoaPermitPayload — EIP-2612 typed data for Arc USDC", () => {
  const base = {
    owner: OWNER,
    spender: SPENDER,
    valueMicro: 10_200_000n, // $10.20 = item + 2% fee
    nonce: 7n,
    nowSeconds: 1_700_000_000,
  };

  it("builds the Arc USDC EIP-712 domain", () => {
    const p = buildEoaPermitPayload(base);
    expect(p.domain).toEqual({
      name: "USDC",
      version: "2",
      chainId: ARC_CHAIN_ID, // 5042002
      verifyingContract: ARC_USDC_CONTRACT.toLowerCase(),
    });
    expect(p.primaryType).toBe("Permit");
  });

  it("uses the canonical Permit type WITHOUT EIP712Domain (wagmi derives it)", () => {
    const p = buildEoaPermitPayload(base);
    expect((p.types as Record<string, unknown>).EIP712Domain).toBeUndefined();
    expect(p.types.Permit).toEqual([
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ]);
  });

  it("message value covers amount+fee, nonce from chain, deadline = now + TTL", () => {
    const p = buildEoaPermitPayload(base);
    expect(p.message.owner.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(p.message.spender.toLowerCase()).toBe(SPENDER.toLowerCase());
    expect(p.message.value).toBe("10200000");
    expect(p.message.nonce).toBe("7");
    expect(p.message.deadline).toBe(String(1_700_000_000 + PERMIT_PAYLOAD_TTL_SECONDS));
    expect(p.deadline).toBe(p.message.deadline);
  });

  it("accepts a custom TTL", () => {
    const p = buildEoaPermitPayload({ ...base, ttlSeconds: 60 });
    expect(p.message.deadline).toBe(String(1_700_000_060));
  });
});

describe("readUsdcPermitInfo — USDC name/version/nonces via injected client", () => {
  type ReadArgs = { functionName: string; args?: unknown[] };
  function stubClient(impl: (args: ReadArgs) => unknown) {
    return { readContract: (async (args: ReadArgs) => impl(args)) as never };
  }

  it("maps name/version/nonce from chain reads", async () => {
    const client = stubClient(({ functionName }) => {
      if (functionName === "name") return "USD Coin";
      if (functionName === "version") return "2";
      if (functionName === "nonces") return 42n;
      throw new Error("unexpected " + functionName);
    });
    const info = await readUsdcPermitInfo(client as never, OWNER);
    expect(info).toEqual({ name: "USD Coin", version: "2", nonce: 42n });
  });

  it("falls back to Arc-verified defaults when name/version reads fail", async () => {
    const client = stubClient(({ functionName }) => {
      if (functionName === "nonces") return 3n;
      throw new Error("rpc flake on " + functionName);
    });
    const info = await readUsdcPermitInfo(client as never, OWNER);
    expect(info.name).toBe("USDC");
    expect(info.version).toBe("2");
    expect(info.nonce).toBe(3n);
  });

  it("propagates nonce-read failure (RPC down → route maps to 503)", async () => {
    const client = stubClient(({ functionName }) => {
      if (functionName === "nonces") throw new Error("RPC unavailable");
      return "x";
    });
    await expect(readUsdcPermitInfo(client as never, OWNER)).rejects.toThrow(/nonce/i);
  });

  it("times out when the RPC hangs (injected timeout)", async () => {
    const client = { readContract: () => new Promise(() => {}) } as never;
    await expect(readUsdcPermitInfo(client, OWNER, 40)).rejects.toThrow(/timeout|unavailable/i);
  }, 5000);
});

describe("CheckoutConfirmBodySchema — permit fields (additive)", () => {
  const ORDER = "550e8400-e29b-41d4-a716-446655440000";
  const R = "0x" + "ab".repeat(32);
  const S = "0x" + "cd".repeat(32);

  it("accepts a confirm body with a full permit", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      payerAddress: OWNER,
      permit: { v: 28, r: R, s: S, deadline: "1700001800", nonce: "7" },
    });
    expect(r.success).toBe(true);
  });

  it("still accepts the legacy approve-tx body (backward compatible)", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      approveTxHash: "0x" + "1".repeat(64),
    });
    expect(r.success).toBe(true);
  });

  it("rejects permit missing r", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      permit: { v: 28, s: S, deadline: "1700001800" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects permit missing s", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      permit: { v: 28, r: R, deadline: "1700001800" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects permit missing v", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      permit: { r: R, s: S, deadline: "1700001800" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects permit missing deadline", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      permit: { v: 28, r: R, s: S },
    });
    expect(r.success).toBe(false);
  });

  it("rejects malformed r/s (not bytes32 hex)", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      permit: { v: 28, r: "0xabc", s: S, deadline: "1700001800" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range v", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      permit: { v: 99, r: R, s: S, deadline: "1700001800" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects malformed payerAddress", () => {
    const r = CheckoutConfirmBodySchema.safeParse({
      orderDraftId: ORDER,
      payerAddress: "not-an-address",
      permit: { v: 28, r: R, s: S, deadline: "1700001800" },
    });
    expect(r.success).toBe(false);
  });
});

describe("resolveConfirmPayer — payer_address + payer_wallet_type resolution", () => {
  const PAYER = OWNER; // 0x1111...
  const UCW = "0x2222222222222222222222222222222222222222";

  const sig = {
    v: 28,
    r: "0x" + "ab".repeat(32),
    s: "0x" + "cd".repeat(32),
    deadline: "1700001800",
  };

  it("permit present → eoa, payer = explicit payerAddress", () => {
    expect(resolveConfirmPayer({ userWalletAddress: UCW, payerAddress: PAYER, permit: sig }))
      .toEqual({ payerWalletType: "eoa", payerAddress: PAYER.toLowerCase() });
  });

  it("permit without payerAddress falls back to session wallet address", () => {
    expect(resolveConfirmPayer({ userWalletAddress: UCW, permit: sig }))
      .toEqual({ payerWalletType: "eoa", payerAddress: UCW.toLowerCase() });
  });

  it("permit with NO resolvable payer → 422 typed error", () => {
    expect(() => resolveConfirmPayer({ permit: sig })).toThrow(/payer/i);
    const e = (() => { try { resolveConfirmPayer({ permit: sig }); } catch (err) { return err; } })() as { httpStatus?: number };
    expect(e.httpStatus).toBe(422);
  });

  it("permit payerAddress must match session wallet when both present (422 otherwise)", () => {
    expect(() =>
      resolveConfirmPayer({ userWalletAddress: UCW, payerAddress: PAYER, permit: sig, strictPayerMatch: true }),
    ).toThrow(/payer/i);
  });

  it("payerAddress without permit, with verified approve tx → eoa", () => {
    expect(resolveConfirmPayer({ userWalletAddress: UCW, payerAddress: PAYER, payerProof: "approve-tx" }))
      .toEqual({ payerWalletType: "eoa", payerAddress: PAYER.toLowerCase() });
  });

  it("payerAddress without permit and without proof → 422 (IDOR guard)", () => {
    expect(() => resolveConfirmPayer({ userWalletAddress: UCW, payerAddress: PAYER })).toThrow(/payer/i);
    const e = (() => { try { resolveConfirmPayer({ userWalletAddress: UCW, payerAddress: PAYER }); } catch (err) { return err; } })() as { httpStatus?: number };
    expect(e.httpStatus).toBe(422);
  });

  it("payerAddress equal to the session wallet needs no proof → eoa", () => {
    expect(resolveConfirmPayer({ userWalletAddress: PAYER, payerAddress: PAYER }))
      .toEqual({ payerWalletType: "eoa", payerAddress: PAYER.toLowerCase() });
  });

  it("no permit + no payerAddress → ucw with session wallet address", () => {
    expect(resolveConfirmPayer({ userWalletAddress: UCW }))
      .toEqual({ payerWalletType: "ucw", payerAddress: UCW.toLowerCase() });
  });

  it("source=platform (legacy custodial/dev-bypass) → platform", () => {
    expect(resolveConfirmPayer({ userWalletAddress: UCW, source: "platform" }))
      .toEqual({ payerWalletType: "platform", payerAddress: UCW.toLowerCase() });
  });
});

// ---------------------------------------------------------------------------
// .F-fix — Finding 1: marketplace EOA checkout was blocked by the UCW
// balance gate at PREPARE. Mirrors the WL pattern (lib/wl/transitions.ts):
// when the client sends payerAddress, the gate targets THAT address on Arc
// instead of the buyer's session UCW; absent → the UCW gate stays.
// ---------------------------------------------------------------------------

describe("resolvePrepareGateTarget — which address prepare gates on Arc", () => {
  const PAYER = "0x1111111111111111111111111111111111111111"; // EOA
  const UCW = "0x2222222222222222222222222222222222222222";

  it("payerAddress present → gate THAT address (EOA external wallet)", () => {
    expect(resolvePrepareGateTarget({ payerAddress: PAYER, ucwAddress: UCW }))
      .toEqual({ kind: "payer", address: PAYER });
  });

  it("payerAddress present wins even when the UCW address is missing", () => {
    expect(resolvePrepareGateTarget({ payerAddress: PAYER }))
      .toEqual({ kind: "payer", address: PAYER });
  });

  it("payerAddress absent → gate the buyer's UCW", () => {
    expect(resolvePrepareGateTarget({ payerAddress: undefined, ucwAddress: UCW }))
      .toEqual({ kind: "ucw", address: UCW });
  });

  it("empty payerAddress is treated as absent", () => {
    expect(resolvePrepareGateTarget({ payerAddress: "", ucwAddress: UCW }))
      .toEqual({ kind: "ucw", address: UCW });
  });

  it("no payerAddress + no UCW → typed 400 error (nothing to gate)", () => {
    expect(() => resolvePrepareGateTarget({ payerAddress: undefined, ucwAddress: null }))
      .toThrow(/wallet address/i);
    let caught: { httpStatus?: number } | null = null;
    try { resolvePrepareGateTarget({}); } catch (e) { caught = e as { httpStatus?: number }; }
    expect(caught?.httpStatus).toBe(400);
  });

  it("mixed-case payerAddress is lowercased in the decision", () => {
    const mixed = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
    expect(resolvePrepareGateTarget({ payerAddress: mixed, ucwAddress: UCW }))
      .toEqual({ kind: "payer", address: mixed.toLowerCase() });
  });
});

describe("CheckoutPrepareBodySchema — optional payerAddress (additive)", () => {
  const PRODUCT = "550e8400-e29b-41d4-a716-446655440000";

  it("accepts a prepare body WITHOUT payerAddress (backward compatible)", () => {
    const r = CheckoutPrepareBodySchema.safeParse({ productId: PRODUCT, qty: 1, payment: "Onchain" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payerAddress).toBeUndefined();
  });

  it("accepts a prepare body WITH a valid payerAddress", () => {
    const r = CheckoutPrepareBodySchema.safeParse({
      productId: PRODUCT,
      payerAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed payerAddress", () => {
    expect(CheckoutPrepareBodySchema.safeParse({ productId: PRODUCT, payerAddress: "nope" }).success).toBe(false);
    expect(CheckoutPrepareBodySchema.safeParse({ productId: PRODUCT, payerAddress: "0x123" }).success).toBe(false);
  });
});

describe("shouldBypassOnChainBalanceGate — mock-mode graceful skip", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("bypasses in mock mode (CIRCLE_PAYMENTS_MOCK !== '0')", () => {
    vi.stubEnv("CIRCLE_PAYMENTS_MOCK", "1");
    expect(shouldBypassOnChainBalanceGate()).toBe(true);
  });

  it("bypasses when CIRCLE_PAYMENTS_MOCK is unset (default dev)", () => {
    vi.stubEnv("CIRCLE_PAYMENTS_MOCK", undefined);
    expect(shouldBypassOnChainBalanceGate()).toBe(true);
  });

  it("bypasses outside production even with CIRCLE_PAYMENTS_MOCK=0", () => {
    vi.stubEnv("CIRCLE_PAYMENTS_MOCK", "0");
    vi.stubEnv("NODE_ENV", "test");
    expect(shouldBypassOnChainBalanceGate()).toBe(true);
  });

  it("does NOT bypass in production with CIRCLE_PAYMENTS_MOCK=0", () => {
    vi.stubEnv("CIRCLE_PAYMENTS_MOCK", "0");
    vi.stubEnv("NODE_ENV", "production");
    expect(shouldBypassOnChainBalanceGate()).toBe(false);
  });
});

/**
 * EIP-2612 signature VERIFICATION.
 *
 * THE HOLE THIS CLOSES: the confirm path used to mark `payerProof = "permit"`
 * just because a `permit` object was in the request body, with no recovery and
 * no comparison against the claimed `payerAddress`. That address became the
 * on-chain buyer of `createOrderFor`; a forged permit fails `_applyPermit`'s
 * ecrecover, and the contract's catch falls back to
 * `allowance(payer, escrow) >= total` — pulling a VICTIM's standing allowance
 * into an attacker-controlled order. These tests sign REAL typed data.
 */
describe("verifyUsdcPermitSignature — recovers the signer, rejects forgeries", () => {
  // Well-known test keys (anvil defaults) — never used on a real network.
  const BUYER = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const ATTACKER = privateKeyToAccount(
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  );
  /** An address the attacker would love to bill instead of themselves. */
  const VICTIM = "0x9999999999999999999999999999999999999999";
  const ESCROW = "0xfe76c63289dd8b5693277df261e4938bd8779d28";
  const VALUE = 1_020_000n; // 1.02 USDC = item 1.00 + 2% buyer fee
  const NONCE = 0n;

  const domain = {
    name: "USDC",
    version: "2",
    chainId: ARC_CHAIN_ID,
    verifyingContract: ARC_USDC_CONTRACT as Hex,
  } as const;

  const futureDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

  async function sign(account: typeof BUYER, overrides: Record<string, unknown> = {}) {
    const message = {
      owner: account.address,
      spender: ESCROW as Hex,
      value: VALUE,
      nonce: NONCE,
      deadline: futureDeadline(),
      ...overrides,
    };
    const signature = await account.signTypedData({
      domain,
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message,
    });
    const parts = splitPermitSignature(signature);
    return { message, parts };
  }

  it("accepts a permit genuinely signed by the claimed payer", async () => {
    const { message, parts } = await sign(BUYER);
    const verified = await verifyUsdcPermitSignature({
      permit: { v: parts.v, r: parts.r, s: parts.s, deadline: String(message.deadline) },
      expectedOwner: BUYER.address,
      expectedSpender: ESCROW,
      valueMicro: VALUE,
      chainNonce: NONCE,
    });
    expect(verified.owner).toBe(BUYER.address.toLowerCase());
    expect(verified.valueMicro).toBe(VALUE);
    expect(verified.spender).toBe(ESCROW.toLowerCase());
  });

  it("REJECTS a valid permit signed by someone else (the allowance-drain hole)", async () => {
    // The attacker produces a perfectly valid signature — but as THEMSELVES,
    // while telling the server that the VICTIM is the payer.
    const { message, parts } = await sign(ATTACKER);
    await expect(
      verifyUsdcPermitSignature({
        permit: { v: parts.v, r: parts.r, s: parts.s, deadline: String(message.deadline) },
        expectedOwner: VICTIM,
        expectedSpender: ESCROW,
        valueMicro: VALUE,
        chainNonce: NONCE,
      }),
    ).rejects.toThrow(/does not match payerAddress/);
  });

  it("rejects a signature over a DIFFERENT amount (value is bound to the order)", async () => {
    // Buyer signed for 0.01 USDC; the order needs 1.02. Recovery over the
    // server-computed value must fail.
    const { message, parts } = await sign(BUYER, { value: 10_000n });
    await expect(
      verifyUsdcPermitSignature({
        permit: { v: parts.v, r: parts.r, s: parts.s, deadline: String(message.deadline) },
        expectedOwner: BUYER.address,
        expectedSpender: ESCROW,
        valueMicro: VALUE,
        chainNonce: NONCE,
      }),
    ).rejects.toThrow(/does not match payerAddress/);
  });

  it("rejects a permit whose spender is not the escrow", async () => {
    const { message, parts } = await sign(BUYER, { spender: ATTACKER.address });
    await expect(
      verifyUsdcPermitSignature({
        permit: { v: parts.v, r: parts.r, s: parts.s, deadline: String(message.deadline) },
        expectedOwner: BUYER.address,
        expectedSpender: ESCROW,
        valueMicro: VALUE,
        chainNonce: NONCE,
      }),
    ).rejects.toThrow(/does not match payerAddress/);
  });

  it("rejects an expired deadline with a clear, actionable error", async () => {
    const { parts } = await sign(BUYER, { deadline: 1n });
    await expect(
      verifyUsdcPermitSignature({
        permit: { v: parts.v, r: parts.r, s: parts.s, deadline: "1" },
        expectedOwner: BUYER.address,
        expectedSpender: ESCROW,
        valueMicro: VALUE,
        chainNonce: NONCE,
      }),
    ).rejects.toThrow(/deadline has already passed/);
  });

  it("falls back to the client-echoed nonce when the on-chain nonce moved", async () => {
    // A permit consumed between payload and confirm bumps nonces(owner).
    // The echoed nonce is a SIGNED field, so recovery still proves ownership.
    const { message, parts } = await sign(BUYER, { nonce: 7n });
    const verified = await verifyUsdcPermitSignature({
      permit: {
        v: parts.v,
        r: parts.r,
        s: parts.s,
        deadline: String(message.deadline),
        nonce: "7",
      },
      expectedOwner: BUYER.address,
      expectedSpender: ESCROW,
      valueMicro: VALUE,
      chainNonce: 8n, // moved on-chain
    });
    expect(verified.owner).toBe(BUYER.address.toLowerCase());
    expect(verified.nonce).toBe(7n);
  });

  it("rejects a malformed owner address", async () => {
    const { message, parts } = await sign(BUYER);
    await expect(
      verifyUsdcPermitSignature({
        permit: { v: parts.v, r: parts.r, s: parts.s, deadline: String(message.deadline) },
        expectedOwner: "not-an-address",
        expectedSpender: ESCROW,
        valueMicro: VALUE,
        chainNonce: NONCE,
      }),
    ).rejects.toThrow(/not a valid address/);
  });

  it("tags every rejection as a typed 422 INVALID_PERMIT", async () => {
    const { message, parts } = await sign(ATTACKER);
    await expect(
      verifyUsdcPermitSignature({
        permit: { v: parts.v, r: parts.r, s: parts.s, deadline: String(message.deadline) },
        expectedOwner: VICTIM,
        expectedSpender: ESCROW,
        valueMicro: VALUE,
        chainNonce: NONCE,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: "INVALID_PERMIT" });
  });
});
