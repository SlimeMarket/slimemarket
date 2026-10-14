/**
 * Gateway Fee Calculator
 *
 * Calculates fees for Gateway cross-chain transfers.
 * Base fee: min($0.50, max($0.05, 0.5% of amount))
 * Markup: ~$0.01-0.05 (covers operational costs)
 *
 * All amounts in micro-USDC (6 decimals, bigint).
 */

import { parseUsdc } from "@/lib/money";

// Fee constants in micro-USDC
const MIN_FEE_MICRO = parseUsdc("0.05"); // $0.05 minimum
const MAX_FEE_MICRO = parseUsdc("0.50"); // $0.50 maximum
const FEE_BPS = 50; // 0.5% = 50 basis points
const MARKUP_LOW_MICRO = parseUsdc("0.01"); // $0.01 markup for small amounts
const MARKUP_HIGH_MICRO = parseUsdc("0.05"); // $0.05 markup for large amounts
const LARGE_AMOUNT_THRESHOLD = parseUsdc("100"); // $100 threshold for high markup

/**
 * Calculate Gateway fee for a cross-chain transfer.
 *
 * Formula:
 * - Base fee: min($0.50, max($0.05, 0.5% of amount))
 * - Markup: $0.01 for amounts < $100, $0.05 for amounts >= $100
 * - Total fee: baseFee + markup
 *
 * @param amount - Transfer amount in micro-USDC (bigint)
 * @returns Fee breakdown in micro-USDC
 */
export function calculateGatewayFee(amount: bigint): {
  baseFee: bigint;
  markup: bigint;
  totalFee: bigint;
} {
  // Calculate percentage fee (0.5% of amount)
  const percentageFee = (amount * BigInt(FEE_BPS)) / 10_000n;

  // Base fee is clamped between min and max
  let baseFee: bigint;
  if (percentageFee < MIN_FEE_MICRO) {
    baseFee = MIN_FEE_MICRO;
  } else if (percentageFee > MAX_FEE_MICRO) {
    baseFee = MAX_FEE_MICRO;
  } else {
    baseFee = percentageFee;
  }

  // Markup based on amount size
  const markup = amount >= LARGE_AMOUNT_THRESHOLD ? MARKUP_HIGH_MICRO : MARKUP_LOW_MICRO;

  return {
    baseFee,
    markup,
    totalFee: baseFee + markup,
  };
}

/**
 * Calculate the net amount received after Gateway fee deduction.
 *
 * @param amount - Gross amount in micro-USDC
 * @returns Net amount after fee deduction
 */
export function calculateNetAfterGatewayFee(amount: bigint): {
  grossAmount: bigint;
  fee: bigint;
  netAmount: bigint;
} {
  const { totalFee } = calculateGatewayFee(amount);

  // Ensure fee doesn't exceed amount
  const fee = totalFee > amount ? amount : totalFee;
  const netAmount = amount - fee;

  return {
    grossAmount: amount,
    fee,
    netAmount,
  };
}

/**
 * Estimate Gateway fee for display purposes.
 * Returns a user-friendly fee estimate string.
 *
 * @param amount - Transfer amount in micro-USDC
 * @returns Formatted fee estimate
 */
export function estimateGatewayFeeDisplay(amount: bigint): {
  minFee: string;
  maxFee: string;
  estimatedFee: string;
} {
  const { totalFee } = calculateGatewayFee(amount);

  return {
    minFee: `$0.06`, // $0.05 base + $0.01 markup
    maxFee: `$0.55`, // $0.50 base + $0.05 markup
    estimatedFee: `$${(Number(totalFee) / 1_000_000).toFixed(2)}`,
  };
}
