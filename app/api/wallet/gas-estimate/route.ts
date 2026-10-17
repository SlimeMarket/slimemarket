import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { arcPublicClient } from "@/lib/arc";
import { formatUsdc } from "@/lib/money";
import { gasReserveMicro, MIN_GAS_RESERVE_MICRO, TRANSFER_GAS_UNITS } from "@/lib/wallet/gas";

/**
 * GET /api/wallet/gas-estimate
 *
 * Estimated network fee, in USDC, for a wallet transfer — derived from the
 * chain's CURRENT gas price rather than a hardcoded constant.
 *
 * WHY: Arc uses USDC as the native gas token, so "gas" is literally the user's
 * balance. The UI used to print a fixed "~$0.01", which is ~16x what a real
 * transfer costs (observed ≈ 0.0006 USDC) — users then over-estimate the cost
 * of every send.
 *
 * The gas LIMIT for a UCW transfer is not knowable ahead of signing, so we use
 * a conservative constant and multiply it by the live base fee. The result is
 * an estimate by construction; it is labelled as such in the UI.
 */

/**
 * Gas limit for a wallet transfer. 21,000 is what a plain native USDC transfer
 * actually costs on Arc (measured against a live transfer); the buffer covers
 * Circle's wrapped-transfer path, which can run a little higher.
 */
const TRANSFER_GAS_UNITS_LOCAL = TRANSFER_GAS_UNITS;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  try {
    const client = arcPublicClient();
    const gasPrice = await client.getGasPrice();
    // Arc's native USDC has 18 decimals; convert to 6-decimal micro-USDC.
    const feeMicro = (gasPrice * TRANSFER_GAS_UNITS_LOCAL) / 10n ** 12n;
    // What the UI must LEAVE in the wallet when the user presses MAX. Circle
    // rejected "balance - estimate" with INSUFFICIENT_NATIVE_TOKEN, so the
    // reserve is the pessimistic one from lib/wallet/gas.ts.
    const reserveMicro = gasReserveMicro(gasPrice);

    return jsonOk({
      gasPriceWei: gasPrice.toString(),
      transferGasUnits: TRANSFER_GAS_UNITS_LOCAL.toString(),
      estimatedFeeMicro: feeMicro.toString(),
      estimatedFeeUsdc: formatUsdc(feeMicro),
      reserveMicro: reserveMicro.toString(),
      reserveUsdc: formatUsdc(reserveMicro),
    });
  } catch (e) {
    // Never break the send modal over a gas read: fall back to the observed
    // value so the UI still shows something honest.
    console.error("[gas-estimate] failed:", e instanceof Error ? e.message : String(e));
    return jsonOk({
      estimatedFeeMicro: "600",
      estimatedFeeUsdc: "0.0006",
      reserveMicro: MIN_GAS_RESERVE_MICRO.toString(),
      reserveUsdc: formatUsdc(MIN_GAS_RESERVE_MICRO),
      fallback: true,
    });
  }
}
