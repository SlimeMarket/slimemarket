import { formatUnits, parseAbiItem, type Address, type Hex, type Log } from "viem";
import { createContractExecutionChallenge } from "@/lib/ucw/contract-execution-challenge";
import {
  CCTP_TOKEN_MESSENGER_V2,
  cctpSourcePublicClient,
  toMintRecipient,
  type CctpSourceChain,
} from "./chains";

/**
 * The source-chain half of a CCTP transfer into Arc, driven by the user's own
 * UCW wallet.
 *
 * WHY NOT APP KIT: `app-kit-bridge/entry.ts` signs through an EIP-1193 provider
 * (`window.ethereum`). An email-login user has no such provider, so the only
 * thing that can authorise the burn is a Circle CONTRACT_EXECUTION challenge
 * signed with their PIN. That means building the calls by hand.
 *
 * THE FLOW IS TWO TRANSACTIONS, AND THAT IS NOT NEGOTIABLE:
 *   1. `USDC.approve(TokenMessengerV2, amount)`
 *   2. `TokenMessengerV2.depositForBurn(amount, 26, mintRecipient, USDC, 0, 0, 2000)`
 * `depositForBurn` pulls the tokens with `transferFrom`, so the allowance must
 * already be mined when step 2 executes. They cannot be batched into one
 * challenge, and step 2 will revert if the caller races ahead of step 1.
 *
 * ALL CHAINS HERE ARE STANDARD-TRANSFER-ONLY (see `standardOnly` in ./chains),
 * so we request `minFinalityThreshold = 2000` (SLOW) with `maxFee = 0`. Asking
 * for FAST (1000) on these chains is the `PRE_FINALITY_UNAVAILABLE` / HTTP 422
 * failure the App Kit bridge already hit.
 *
 * ABI NOTE: the `depositForBurn` signature below (7 args, including
 * `destinationCaller`, `maxFee`, `minFinalityThreshold`) was read out of
 * `@circle-fin/adapter-viem-v2`, not recalled. CCTP v2 changed this signature
 * from v1, and a wrong arg list here is a silent no-op at best and a
 * misdirected burn at worst.
 */

/** CCTP v2 finality thresholds (basis points). 1000 = FAST, 2000 = SLOW. */
export const MIN_FINALITY_FAST = 1000;
export const MIN_FINALITY_STANDARD = 2000;

/**
 * No fast-transfer fee: every supported source chain is standard-only, so the
 * fast liquidity path is unavailable and paying a fee would buy nothing.
 */
export const CCTP_MAX_FEE = 0n;

/** bytes32(0) = any caller may submit the mint on Arc (our relayer will). */
const ANY_CALLER: Hex = `0x${"0".repeat(64)}`;

const ERC20_ABI = [
  parseAbiItem("function balanceOf(address owner) view returns (uint256)"),
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
] as const;

export interface SourceBalances {
  /** USDC available to bridge (atomic units, 6 dp). */
  usdc: bigint;
  /** Native gas token (ETH/AVAX) — required to submit the burn. */
  native: bigint;
  nativeSymbol: string;
  /** Current allowance granted to the TokenMessenger. */
  allowance: bigint;
  /** True when the allowance already covers `neededMicro`. */
  allowanceSufficient: boolean;
  /** True when the wallet holds enough native token to pay for two txs. */
  hasGas: boolean;
}

/**
 * Everything the UI needs to decide whether a bridge can even be attempted.
 *
 * The native balance is the one that actually blocks people: a UCW user holds
 * USDC on the source chain but no ETH/AVAX, because nothing in the app ever put
 * any there. Surfacing it up front turns a confusing revert into an instruction.
 *
 * `neededMicro` defaults to 0 so this doubles as a plain balance read.
 */
export async function readSourceBalances(
  chain: CctpSourceChain,
  owner: Address,
  neededMicro: bigint = 0n,
): Promise<SourceBalances> {
  const client = cctpSourcePublicClient(chain);

  const [usdc, native, allowance] = await Promise.all([
    client.readContract({
      address: chain.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    }),
    client.getBalance({ address: owner }),
    client.readContract({
      address: chain.usdc,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, CCTP_TOKEN_MESSENGER_V2],
    }),
  ]);

  return {
    usdc,
    native,
    nativeSymbol: chain.nativeSymbol,
    allowance,
    allowanceSufficient: allowance >= neededMicro,
    // Two txs (approve + burn) with a small margin. A dust-level balance is
    // worse than zero because it fails at the second tx instead of the first.
    hasGas: native > 0n,
  };
}

/**
 * Build the `approve` challenge for the TokenMessenger.
 *
 * Called only when the existing allowance is insufficient, so repeat bridges
 * skip this step entirely.
 */
export async function createApproveChallenge(params: {
  userToken: string;
  walletId: string;
  chain: CctpSourceChain;
  amountMicro: bigint;
}): Promise<{ challengeId: string; txId: string }> {
  const { userToken, walletId, chain, amountMicro } = params;
  if (amountMicro <= 0n) throw new Error("approve amount must be greater than 0");

  return createContractExecutionChallenge({
    userToken,
    walletId,
    contractAddress: chain.usdc,
    abiFunctionSignature: "approve(address,uint256)",
    // Exactly the amount being bridged — not an unlimited allowance. An
    // unlimited approval left on a wallet the user may abandon is a standing
    // risk on every chain, and this flow never needs it.
    abiParameters: [CCTP_TOKEN_MESSENGER_V2, amountMicro.toString()],
  });
}

/**
 * Build the `depositForBurn` challenge.
 *
 * `mintRecipient` is the user's OWN Arc address, so the minted USDC lands in
 * their wallet and never in a platform account.
 */
export async function createBurnChallenge(params: {
  userToken: string;
  walletId: string;
  chain: CctpSourceChain;
  amountMicro: bigint;
  arcRecipient: string;
  arcDomain: number;
}): Promise<{ challengeId: string; txId: string }> {
  const { userToken, walletId, chain, amountMicro, arcRecipient, arcDomain } = params;
  if (amountMicro <= 0n) throw new Error("burn amount must be greater than 0");
  if (arcDomain <= 0) throw new Error("arcDomain must be a positive CCTP domain");

  return createContractExecutionChallenge({
    userToken,
    walletId,
    contractAddress: CCTP_TOKEN_MESSENGER_V2,
    abiFunctionSignature:
      "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
    abiParameters: [
      amountMicro.toString(),
      String(arcDomain),
      toMintRecipient(arcRecipient),
      chain.usdc,
      ANY_CALLER,
      CCTP_MAX_FEE.toString(),
      String(MIN_FINALITY_STANDARD),
    ],
  });
}

export interface TxCheck {
  ok: boolean;
  blockNumber?: bigint;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

/**
 * Verify a source-chain transaction really did what we asked, before treating a
 * client-supplied hash as progress.
 *
 * The tx hash arrives from the browser, so it is untrusted input. Without this
 * check a caller could hand us any hash and have a bridge row marked APPROVED
 * or BURNED for a transfer that never happened.
 *
 * Deliberately does NOT decode the CCTP event. CCTP v2's `DepositForBurn` gained
 * fields over v1, and an ABI-shape assumption is exactly the class of bug that
 * already cost us once (a 17-field struct read through a 10-field ABI, silently
 * shifting every index). Receipt shape plus Iris (see ./attestation) is the
 * authoritative pair; Iris in particular cannot be faked, because it only
 * produces a message for a burn its validators actually observed.
 */
export async function verifySourceTx(params: {
  chain: CctpSourceChain;
  txHash: string;
  expectedFrom: Address;
  expectedTo: Address;
}): Promise<TxCheck> {
  const { chain, txHash, expectedFrom, expectedTo } = params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: "Transaction hash is not a 32-byte hex string" };
  }

  const client = cctpSourcePublicClient(chain);

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
  } catch {
    return { ok: false, reason: "Transaction not found on the source chain yet" };
  }

  if (receipt.status !== "success") {
    return { ok: false, reason: "Transaction reverted on the source chain" };
  }
  if (receipt.to?.toLowerCase() !== expectedTo.toLowerCase()) {
    return { ok: false, reason: "Transaction did not target the expected contract" };
  }
  if (receipt.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    return { ok: false, reason: "Transaction was not sent by the user's wallet" };
  }

  return { ok: true, blockNumber: receipt.blockNumber };
}

/**
 * Sum the USDC actually pulled into the TokenMessenger by a burn transaction.
 *
 * Reads the standard ERC-20 `Transfer` event rather than CCTP's own event, so it
 * stays correct if CCTP adds fields again. Returns 0n when no matching transfer
 * is present, which callers should treat as "unverified amount".
 */
export function burnedUsdcFromReceipt(
  logs: Log[],
  from: Address,
  usdc: Address,
): bigint {
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== usdc.toLowerCase()) continue;
    // Only the 3-topic Transfer shape is a match.
    if (!log.topics || log.topics.length !== 3) continue;
    try {
      const decoded = decodeTransfer(log);
      if (!decoded) continue;
      if (decoded.from.toLowerCase() !== from.toLowerCase()) continue;
      if (decoded.to.toLowerCase() !== CCTP_TOKEN_MESSENGER_V2.toLowerCase()) continue;
      total += decoded.value;
    } catch {
      // A malformed log must not abort the whole receipt — just skip it.
    }
  }
  return total;
}

/**
 * keccak256("Transfer(address,address,uint256)").
 *
 * Compared as a literal rather than via `ERC20_TRANSFER.topic0`, because viem
 * does not expose `topic0` on a parsed ABI item in every version — reading it
 * would be a type error today and a silent `undefined` comparison tomorrow.
 */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Decode a standard ERC-20 Transfer log, or null when it is not one. */
function decodeTransfer(log: Log): { from: string; to: string; value: bigint } | null {
  const topic0 = log.topics[0];
  if (!topic0 || topic0.toLowerCase() !== TRANSFER_TOPIC) return null;

  // Indexed address topics are left-padded to 32 bytes; the address is the
  // trailing 20. Slicing the topic directly avoids pulling in an ABI decoder
  // for a shape that has been fixed since ERC-20 was written.
  const from = `0x${log.topics[1]!.slice(26)}`;
  const to = `0x${log.topics[2]!.slice(26)}`;

  let value: bigint;
  try {
    value = BigInt(log.data);
  } catch {
    return null; // not a uint256 — some other event sharing the topic
  }
  return { from, to, value };
}

/** Format atomic USDC for display, trimmed to something a human reads. */
export function formatUsdcAmount(micro: bigint): string {
  const s = formatUnits(micro, 6);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
