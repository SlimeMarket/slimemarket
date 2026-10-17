/**
 * Gas reservation for an outbound UCW transfer.
 *
 * Arc pays gas in USDC, so the amount the user sends and the amount needed for
 * the fee come out of the SAME balance. The UI used to reserve only the
 * *displayed estimate* (~0.0006 USDC); Circle then rejected the transfer with
 * `INSUFFICIENT_NATIVE_TOKEN` after the user had already approved it with their
 * PIN, and the app showed PENDING forever.
 *
 * The reserve below is deliberately pessimistic: Circle wraps the transfer
 * (higher gas limit than a plain native send) and picks a max fee above the
 * live base fee. Sending "max" must leave enough for that worst case.
 */
export const TRANSFER_GAS_UNITS = 60_000n;

/** Never reserve less than this (0.003 USDC) — covers Circle's wrapper + fee bump. */
export const MIN_GAS_RESERVE_MICRO = 3_000n;

/** Reserve in micro-USDC (6 dp) for the given gas price in wei (18 dp). */
export function gasReserveMicro(gasPriceWei: bigint): bigint {
  const estimate = (gasPriceWei * TRANSFER_GAS_UNITS) / 10n ** 12n;
  const doubled = estimate * 2n;
  return doubled > MIN_GAS_RESERVE_MICRO ? doubled : MIN_GAS_RESERVE_MICRO;
}
