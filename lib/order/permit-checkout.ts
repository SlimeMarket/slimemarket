import { isAddress, recoverTypedDataAddress, type Hex } from "viem";
import { ARC_CHAIN_ID, ARC_USDC_CONTRACT } from "@/lib/arc";

/**
 * .D — EOA external-wallet checkout (MetaMask/Coinbase via wallet-bridge).
 *
 * PRIMARY path: EIP-2612 permit (gasless). The buyer signs this typed data in
 * their wallet; the platform DCW relays `createOrderFor(buyer, seller, amount,
 * buyerFee, deadline, v, r, s)` and pays gas in USDC.
 *
 * Contract facts (contracts/MarketEscrow.sol L115-134):
 *   - `createOrderFor` pulls `total = amount + buyerFee` from the BUYER via
 *     `_applyPermit(buyer, total, deadline, v, r, s)` + safeTransferFrom.
 *   - The permit `value` therefore MUST cover amount + buyerFee.
 *   - `_applyPermit` is try/catch: a consumed/front-run permit tolerates an
 *     existing sufficient allowance (same fallback the approve path uses).
 *
 * Arc USDC EIP-712 domain: name "USDC", version "2", chainId 5042002,
 * verifyingContract 0x3600...0000. `readUsdcPermitInfo` reads name/version
 * straight off the token, so this module is the single source of truth for the
 * permit typed data. (A duplicate builder used to live in
 * lib/contracts/permit-builder.ts; it was never called and was deleted in * — duplicated permit logic is exactly what drifts.)
 */

/** Permit validity window (30 min — short-lived per spec; builder TTL is 1h). */
export const PERMIT_PAYLOAD_TTL_SECONDS = 30 * 60;

/** Deadline for chain reads (name/version/nonces) before failing with 503. */
const CHAIN_READ_TIMEOUT_MS = 15_000;

/** EIP-2612 `Permit` struct — canonical field order (no EIP712Domain; wagmi
 * derives the domain type from the `domain` object itself). */
export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface PermitPayloadDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export interface PermitPayloadMessage {
  owner: string;
  spender: string;
  /** Micro-USDC decimal string — MUST be itemAmount + buyerFee (contract fact). */
  value: string;
  /** Current on-chain USDC.nonces(owner), read by the server. */
  nonce: string;
  /** Unix seconds — server-authoritative. */
  deadline: string;
}

export interface PermitPayload {
  domain: PermitPayloadDomain;
  types: { Permit: { name: string; type: string }[] };
  primaryType: "Permit";
  message: PermitPayloadMessage;
  /** Echoed top-level for FE convenience (same as message.deadline). */
  deadline: string;
}

/**
 * Build the complete EIP-2612 permit payload for an EOA buyer. Pure — all
 * chain-derived inputs (name, version, nonce) are passed in, so the endpoint
 * can inject a stub client in tests.
 */
export function buildEoaPermitPayload(params: {
  owner: string;
  spender: string;
  valueMicro: bigint;
  nonce: bigint;
  /** Token name/domain name (defaults to the Arc-verified "USDC"). */
  tokenName?: string;
  /** Token EIP-712 version (defaults to the Arc-verified "2"). */
  tokenVersion?: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): PermitPayload {
  if (!isAddress(params.owner)) throw new Error(`invalid owner address: ${params.owner}`);
  if (!isAddress(params.spender)) throw new Error(`invalid spender address: ${params.spender}`);
  if (params.valueMicro <= 0n) throw new Error("permit value must be positive");
  if (params.nonce < 0n) throw new Error("permit nonce must be >= 0");

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = params.ttlSeconds ?? PERMIT_PAYLOAD_TTL_SECONDS;
  const deadline = String(now + ttl);

  return {
    domain: {
      name: params.tokenName ?? "USDC",
      version: params.tokenVersion ?? "2",
      chainId: ARC_CHAIN_ID,
      verifyingContract: ARC_USDC_CONTRACT.toLowerCase(),
    },
    types: { Permit: [...PERMIT_TYPES.Permit] },
    primaryType: "Permit",
    message: {
      owner: params.owner,
      spender: params.spender,
      value: params.valueMicro.toString(),
      nonce: params.nonce.toString(),
      deadline,
    },
    deadline,
  };
}

// ---------------------------------------------------------------------------
// Chain reads (injectable for tests; the route passes a real arcPublicClient)
// ---------------------------------------------------------------------------

/** Minimal structural client (viem PublicClient-shaped) for unit tests. */
export interface PermitChainReader {
  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

/** EIP-2612 read ABI (nonces + name + version). */
const ERC2612_READ_ABI = [
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** Race a promise against a timeout — RPC hangs must not stall checkout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Read the EIP-2612 inputs for `owner` from Arc USDC: token name + version
 * (fall back to the Arc-verified "USDC"/"2" when those optional reads fail)
 * and the current `nonces(owner)` (nonce read is MANDATORY — a wrong nonce
 * makes the permit unspendable, so failures propagate → route maps to 503).
 */
export async function readUsdcPermitInfo(
  client: PermitChainReader,
  owner: string,
  timeoutMs: number = CHAIN_READ_TIMEOUT_MS,
): Promise<{ name: string; version: string; nonce: bigint }> {
  if (!isAddress(owner)) throw new Error(`invalid owner address: ${owner}`);

  const read = (functionName: string, args?: readonly unknown[]) =>
    withTimeout(
      client.readContract({
        address: ARC_USDC_CONTRACT,
        abi: ERC2612_READ_ABI,
        functionName,
        args,
      }) as Promise<bigint | string>,
      timeoutMs,
      functionName,
    );

  const [name, version, nonce] = await Promise.all([
    read("name").catch(() => "USDC"),
    read("version").catch(() => "2"),
    read("nonces", [owner]).catch((e) => {
      // Nonce is MANDATORY — a stale/guessed nonce makes the permit
      // unspendable. Surface RPC failures cleanly (route maps to 503).
      throw new Error(`USDC nonce read failed (RPC unavailable?): ${(e as Error).message}`);
    }),
  ]);

  return { name: name as string, version: version as string, nonce: nonce as bigint };
}

// ---------------------------------------------------------------------------
// Signature splitting (FE mirror: wallet-bridge returns r||s||v as 0x+130 hex)
// ---------------------------------------------------------------------------

export interface PermitSigParts {
  v: number;
  r: string; // 0x + 64 hex
  s: string; // 0x + 64 hex
}

/**
 * Split a 65-byte ECDSA signature (0x + 130 hex chars) into r, s, v.
 * Layout: r = bytes[0:32], s = bytes[32:64], v = byte[64].
 * Throws on malformed input (routes map this to 400).
 */
export function splitPermitSignature(sig: string): PermitSigParts {
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error("invalid permit signature: expected 0x + 130 hex chars (65 bytes)");
  }
  return {
    r: "0x" + sig.slice(2, 66),
    s: "0x" + sig.slice(66, 130),
    v: parseInt(sig.slice(130, 132), 16),
  };
}

// ---------------------------------------------------------------------------
// EIP-2612 signature VERIFICATION
// ---------------------------------------------------------------------------

/** Typed 422 — the confirm route maps `httpStatus` straight to the response. */
function permitError(msg: string): Error & { httpStatus: number; code: string } {
  const e = new Error(msg) as Error & { httpStatus: number; code: string };
  e.httpStatus = 422;
  e.code = "INVALID_PERMIT";
  return e;
}

export interface VerifyUsdcPermitInput {
  /** The signature parts the client sent (plus its optional nonce echo). */
  permit: { v: number; r: string; s: string; deadline: string; nonce?: string };
  /** The address the client CLAIMS signed the permit (permit owner). */
  expectedOwner: string;
  /** The escrow contract — the only spender a permit may authorize. */
  expectedSpender: string;
  /**
   * The EXACT `value` the buyer signed, in micro-USDC. The server recomputes it
   * from its own held draft (itemAmount + buyerFee), never from client input —
   * so a signature made for a different amount simply fails to recover.
   */
  valueMicro: bigint;
  /** Live `USDC.nonces(expectedOwner)`, read by the caller. */
  chainNonce: bigint;
  /** EIP-712 domain name/version read on-chain (defaults to Arc's "USDC"/"2"). */
  tokenName?: string;
  tokenVersion?: string;
  /** Injectable clock (seconds) for tests. */
  nowSeconds?: number;
}

export interface VerifiedPermit {
  owner: string;
  spender: string;
  valueMicro: bigint;
  nonce: bigint;
  deadline: bigint;
}

/**
 * Cryptographically verify an EIP-2612 permit and return the PROVEN signer.
 *
 * WHY THIS EXISTS (P0)
 * --------------------------
 * The confirm path used to set `payerProof = "permit"` merely because a
 * `permit` object was present in the request body — no recovery, no comparison.
 * `resolveConfirmPayer` then accepted whatever `payerAddress` the client named,
 * and that address became the on-chain `buyer` of `createOrderFor`. An attacker
 * could therefore name a VICTIM who already had a standing USDC allowance to
 * the escrow; the forged permit fails `_applyPermit`'s ecrecover, the contract's
 * catch falls back to `allowance(victim, escrow) >= total`, and the victim's
 * approved USDC is pulled into an order the attacker controls.
 *
 * The server can fully reconstruct the signed message because every field is
 * either server-known (spender, value, chainId, verifyingContract) or
 * server-read (nonce). A successful recovery therefore proves the owner signed
 * THIS order's exact amount to THIS escrow.
 *
 * Throws a typed 422 (`INVALID_PERMIT`) on any mismatch.
 */
export async function verifyUsdcPermitSignature(
  input: VerifyUsdcPermitInput,
): Promise<VerifiedPermit> {
  const { permit } = input;

  if (!isAddress(input.expectedOwner)) {
    throw permitError(`permit owner is not a valid address: ${input.expectedOwner}`);
  }
  if (!isAddress(input.expectedSpender)) {
    throw permitError("escrow spender address is not configured");
  }
  if (input.valueMicro <= 0n) {
    throw permitError("permit value must be positive");
  }

  const deadline = BigInt(permit.deadline);
  const now = BigInt(input.nowSeconds ?? Math.floor(Date.now() / 1000));
  if (deadline <= now) {
    throw permitError("permit deadline has already passed — please sign again");
  }

  const signature = `0x${permit.r.slice(2)}${permit.s.slice(2)}${permit.v
    .toString(16)
    .padStart(2, "0")}` as Hex;

  const domain = {
    name: input.tokenName ?? "USDC",
    version: input.tokenVersion ?? "2",
    chainId: ARC_CHAIN_ID,
    verifyingContract: ARC_USDC_CONTRACT as Hex,
  } as const;

  // The on-chain nonce is authoritative. A permit consumed between
  // permit-payload and confirm bumps it, so also try the client's echo — the
  // nonce is a SIGNED field, so a successful recovery still proves ownership;
  // trying candidates cannot weaken the check.
  const nonces: bigint[] = [input.chainNonce];
  if (permit.nonce !== undefined) {
    const echoed = BigInt(permit.nonce);
    if (echoed !== input.chainNonce) nonces.push(echoed);
  }

  let recovered: string | null = null;
  let usedNonce = input.chainNonce;

  for (const nonce of nonces) {
    try {
      const addr = await recoverTypedDataAddress({
        domain,
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: {
          owner: input.expectedOwner,
          spender: input.expectedSpender,
          value: input.valueMicro,
          nonce,
          deadline,
        },
        signature,
      });
      if (addr.toLowerCase() === input.expectedOwner.toLowerCase()) {
        recovered = addr;
        usedNonce = nonce;
        break;
      }
    } catch {
      // Malformed signature for this nonce candidate — try the next one.
    }
  }

  if (!recovered) {
    throw permitError(
      "permit signature does not match payerAddress — the permit was not signed by the address that is supposed to pay",
    );
  }

  return {
    owner: recovered.toLowerCase(),
    spender: input.expectedSpender.toLowerCase(),
    valueMicro: input.valueMicro,
    nonce: usedNonce,
    deadline,
  };
}

// ---------------------------------------------------------------------------
// Payer resolution (migration 0050: payer_wallet_type in ('ucw','eoa','platform'))
// ---------------------------------------------------------------------------

export type PayerWalletType = "ucw" | "eoa" | "platform";

export interface ResolvePayerInput {
  /** Buyer's platform UCW address (session wallet) — may be undefined. */
  userWalletAddress?: string | null;
  /** Client-sent payerAddress (EOA). Validated by zod ArcAddressSchema upstream. */
  payerAddress?: string;
  /** Present → the gasless permit path is being taken. */
  permit?: { v: number; r: string; s: string; deadline: string };
  /** Legacy custodial / dev-bypass source → always 'platform'. */
  source?: "platform";
  /** When true, an explicit payerAddress MUST equal the session wallet (unused
   *  by the EOA flow; reserved for strict-UCW checks). */
  strictPayerMatch?: boolean;
  /**
   * SECURITY: what proves the payer controls the address it names.
   *   'permit'     → a verified EIP-2612 signature from that address;
   *   'approve-tx' → an approve transaction whose on-chain `from` is that address;
   *   null/undefined → no proof.
   * A payerAddress that is NOT the session's own wallet and has no proof is
   * rejected: otherwise an attacker can name any address, and the escrow's
   * allowance fallback (`_applyPermit` → allowance(payer, escrow)) pulls the
   * VICTIM's approved USDC into a deal whose on-chain buyer is the victim.
   */
  payerProof?: "permit" | "approve-tx" | null;
}

export interface ResolvedPayer {
  payerWalletType: PayerWalletType;
  /** Lowercased 0x address of the wallet that pays. */
  payerAddress: string;
}

/**
 * Decide which wallet pays and how to label it (orders.payer_wallet_type).
 * Rules (.D):
 *   - source=platform (legacy custodial / dev-bypass) → 'platform'.
 *   - permit present → 'eoa'; payer = payerAddress ?? session wallet; a permit
 *     with NO resolvable payer is a typed 422 error.
 *   - payerAddress only (approve-tx fallback from the EOA) → 'eoa', but only
 *     with `payerProof` (verified permit/approve tx); otherwise a typed 422.
 *   - otherwise → 'ucw' (Circle UCW challenge path), payer = session wallet.
 * Pure — no I/O. Throws ApiValidationError-shaped errors (httpStatus 422).
 */
export function resolveConfirmPayer(input: ResolvePayerInput): ResolvedPayer {
  const typedError = (msg: string): Error & { httpStatus: number; code: string } => {
    const e = new Error(msg) as Error & { httpStatus: number; code: string };
    e.httpStatus = 422;
    e.code = "INVALID_PAYER";
    return e;
  };

  const sessionAddr = input.userWalletAddress ?? null;
  const explicit = input.payerAddress ? input.payerAddress.toLowerCase() : null;

  if (input.source === "platform") {
    return { payerWalletType: "platform", payerAddress: (explicit ?? sessionAddr ?? "").toLowerCase() };
  }

  if (input.permit) {
    const payer = explicit ?? sessionAddr;
    if (!payer || !isAddress(payer)) {
      throw typedError("permit confirm requires payerAddress (the EOA that signed the permit)");
    }
    if (input.strictPayerMatch && explicit && sessionAddr && explicit !== sessionAddr.toLowerCase()) {
      throw typedError("payerAddress does not match the session wallet");
    }
    return { payerWalletType: "eoa", payerAddress: payer.toLowerCase() };
  }

  if (explicit) {
    if (!isAddress(explicit)) throw typedError(`invalid payerAddress: ${explicit}`);
    // an explicit payer with NO proof of control may only be the
    // session's own wallet. Anything else must arrive with a verified permit or
    // a verified approve tx (whose on-chain sender is that address); otherwise
    // this is the "name someone else's address and drain their allowance" hole.
    const isOwnWallet = !!sessionAddr && explicit === sessionAddr.toLowerCase();
    if (!isOwnWallet && !input.payerProof) {
      throw typedError(
        "payerAddress is not the session wallet — a permit signed by it, or an approve transaction sent from it, is required",
      );
    }
    return { payerWalletType: "eoa", payerAddress: explicit };
  }

  // UCW challenge path — payer is the buyer's Circle UCW.
  return { payerWalletType: "ucw", payerAddress: (sessionAddr ?? "").toLowerCase() };
}

// ---------------------------------------------------------------------------
// .F-fix — PREPARE-stage balance-gate target resolution
// ---------------------------------------------------------------------------

export interface PrepareGateTarget {
  /** 'payer' = the client-provided EOA pays; 'ucw' = the buyer's session UCW. */
  kind: "payer" | "ucw";
  /** Lowercased 0x address whose on-chain balance the prepare gate checks. */
  address: string;
}

/**
 * Decide which address the PREPARE on-chain balance gate targets. Pure — no I/O.
 *
 * Mirrors the WL pattern (lib/wl/transitions.ts prepareWlDeal): when the buyer
 * pays from an external wallet (EOA), the client sends `payerAddress` and the
 * gate must check THAT address on Arc — gating the buyer's session UCW instead
 * wrongly blocks every EOA checkout. Absent → the session UCW gate stays.
 *
 * Throws a typed 400 error when there is no address to gate (no payer AND no
 * session UCW) — same message the old code raised for a missing UCW.
 */
export function resolvePrepareGateTarget(input: {
  payerAddress?: string | null;
  ucwAddress?: string | null;
}): PrepareGateTarget {
  const payer = input.payerAddress ?? "";
  if (payer) return { kind: "payer", address: payer.toLowerCase() };
  const ucw = input.ucwAddress ?? "";
  if (ucw) return { kind: "ucw", address: ucw };
  const e = new Error("buyer has no on-chain wallet address") as Error & { httpStatus: number };
  e.httpStatus = 400;
  throw e;
}
