import { circleUcwSdk } from "@/lib/circle/ucw-client";

/**
 * Create a Circle UCW CONTRACT_EXECUTION challenge — lets a user-controlled
 * wallet call an arbitrary smart contract method (e.g. `USDC.approve(escrow,
 * amount)`) by signing with their PIN via the W3S SDK in the browser.
 *
 * This is the user-authorization layer for the non-custodial F2-FE checkout
 * flow (Opsi B: pre-approve + relayer pull). The buyer's UCW (a Smart Contract
 * Account) cannot produce an EIP-2612 (v,r,s) permit signature that
 * `ecrecover` can validate, so we route authorization through Circle's
 * CONTRACT_EXECUTION challenge: the user signs an approve() call directly,
 * then the DCW relayer calls `createOrderFor` with a dummy permit (the
 * contract's `_applyPermit` try/catch falls back to checking `allowance`).
 *
 * Uses the official `@circle-fin/user-controlled-wallets` SDK method
 * `createUserTransactionContractExecutionChallenge` (per Circle skill
 * `use-user-controlled-wallets/references/contract-execution.md`).
 *
 * Returns `{ challengeId, txId }`:
 *   - `challengeId`: pass to `W3SSdk.execute()`.
 *   - `txId`: Circle's transaction UUID; poll via
 *     `circleDeveloperSdk.getTransaction({id})` (or circleUcwSdk equivalent)
 *     to track state (CONFIRMED / FAILED / etc.) — see `waitForCircleTxState`.
 */
export async function createContractExecutionChallenge(params: {
  /** Buyer's Circle wallet ID (UCW). */
  walletId: string;
  /** Target contract address (e.g. USDC token address). */
  contractAddress: string;
  /** Solidity function signature, e.g. `"approve(address,uint256)"`. */
  abiFunctionSignature: string;
  /** ABI-encoded parameters (strings; Circle encodes them server-side). */
  abiParameters: string[];
  /** Buyer's UCW user token (read from httpOnly cookie server-side). */
  userToken: string;
  /** Fee level for the on-chain tx (default MEDIUM per Circle recommendation). */
  feeLevel?: "LOW" | "MEDIUM" | "HIGH";
}): Promise<{ challengeId: string; txId: string }> {
  const {
    walletId, contractAddress, abiFunctionSignature, abiParameters, userToken,
    feeLevel = "MEDIUM",
  } = params;

  if (!walletId) throw new Error("walletId required");
  if (!contractAddress) throw new Error("contractAddress required");
  if (!abiFunctionSignature) throw new Error("abiFunctionSignature required");
  if (!userToken) throw new Error("userToken required");
  if (!circleUcwSdk) throw new Error("Circle UCW SDK not configured (CIRCLE_API_KEY missing)");

  const response = await circleUcwSdk.createUserTransactionContractExecutionChallenge({
    userToken,
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    fee: { type: "level", config: { feeLevel } },
  });

  const challengeId = response.data?.challengeId;
  if (!challengeId) {
    throw new Error(
      `createContractExecutionChallenge: no challengeId in response: ${JSON.stringify(response.data ?? {}).slice(0, 300)}`,
    );
  }
  // UCW contract-execution challenge response only contains `challengeId`.
  // The actual Circle tx id + on-chain txHash are NOT in the response — they
  // only appear AFTER the user approves the challenge via W3SSdk.execute in
  // the browser. The FE callback receives a `SignTransactionResult` (or
  // similar) with `data.txHash` (on-chain hash). The FE passes that txHash
  // back to the confirm endpoint, which verifies it via Arc RPC instead of
  // polling Circle's transaction API.
  //
  // We return txId = challengeId for backward-compat with the existing FE
  // flow, but confirm endpoints MUST NOT call waitForCircleTxState with it.
  // They should accept the on-chain txHash from the FE callback instead.
  return { challengeId, txId: challengeId };
}
