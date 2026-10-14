import { randomUUID } from "crypto";
import { circleUcwSdk } from "@/lib/circle/ucw-client";

/**
 * Circle UCW TRANSFER challenge.
 *
 * Lets a user-controlled wallet send USDC to an external Arc address by
 * approving the transfer with their PIN in Circle's hosted UI (W3SSdk).
 * This is the security upgrade over the legacy platform-DCW reimburse model:
 * funds move FROM the user's OWN wallet, signed on their device — so a
 * compromised email session alone cannot drain funds.
 *
 * Uses the official `@circle-fin/user-controlled-wallets` SDK method
 * `createUserTransactionTransferChallenge` (POST /v1/w3s/user/transactions/transfer).
 *
 * Returns `{ challengeId }`:
 *   - `challengeId`: pass to `W3SSdk.execute()` in the browser (PIN prompt).
 *     The FE callback receives the on-chain `txHash`; the server verifies it
 *     via Arc RPC at settle time (lib/wallet/ucw-send.ts). Circle's tx UUID
 *     is only available post-execution, so we verify on-chain instead.
 *
 * NOTE (gas on Arc): Arc pays gas in USDC, so the user's wallet must hold a
 * small USDC buffer beyond the send amount for the transfer to succeed
 * on-chain. The FE surfaces this as a note.
 */
export async function createTransferChallenge(params: {
  /** User's Circle wallet ID (UCW, ARC-TESTNET EOA). */
  walletId: string;
  /** Destination Arc address (0x…, already checksummed by the caller). */
  destinationAddress: string;
  /** Decimal USDC amount as a string (e.g. "5.25"). */
  amountDecimal: string;
  /** Circle token id for Arc USDC. */
  tokenId: string;
  /** User's UCW user token (read from httpOnly cookie server-side). */
  userToken: string;
  /** Fee level for the on-chain tx (default LOW — simple transfer). */
  feeLevel?: "LOW" | "MEDIUM" | "HIGH";
}): Promise<{ challengeId: string }> {
  const {
    walletId, destinationAddress, amountDecimal, tokenId, userToken,
    feeLevel = "LOW",
  } = params;

  if (!walletId) throw new Error("walletId required");
  if (!destinationAddress) throw new Error("destinationAddress required");
  if (!amountDecimal) throw new Error("amountDecimal required");
  if (!tokenId) throw new Error("tokenId required");
  if (!userToken) throw new Error("userToken required");
  if (!circleUcwSdk) throw new Error("Circle UCW SDK not configured (CIRCLE_API_KEY missing)");

  // Friendly SDK method for UCW TRANSFER challenges = `createTransaction`
  // (the low-level name is createUserTransactionTransferChallenge).
  const response = await circleUcwSdk.createTransaction({
    userToken,
    walletId,
    destinationAddress,
    tokenId,
    amounts: [amountDecimal],
    // Idempotency: same key reused → Circle returns the original challenge
    // instead of creating a duplicate transfer intent.
    idempotencyKey: randomUUID(),
    fee: { type: "level", config: { feeLevel } },
  });

  const challengeId = response.data?.challengeId;
  if (!challengeId) {
    throw new Error(
      `createTransferChallenge: no challengeId in response: ${JSON.stringify(response.data ?? {}).slice(0, 300)}`,
    );
  }
  return { challengeId };
}
