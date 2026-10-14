/**
 * Money utilities. USDC has 6 decimals. All amounts in DB/API = integer micro-USDC (bigint).
 *
 * GOLDEN RULE (AGENTS.md): money is integer minor-unit, NEVER float.
 * Convert at the boundary (user input string / display string) and keep internal
 * representation as bigint everywhere else.
 */

export const USDC_DECIMALS = 6;
const ONE_USDC = 10n ** BigInt(USDC_DECIMALS); // 1_000_000

/**
 * Parse a human-readable USDC amount string (e.g. "1.5", "0.01", "189") into
 * micro-USDC bigint. Avoids float imprecision by splitting on the decimal point
 * and operating on integer parts.
 *
 * Throws on malformed input or negative values.
 *
 * Examples:
 *   parseUsdc("1")      => 1_000_000n
 *   parseUsdc("1.5")    => 1_500_000n
 *   parseUsdc("0.01")   => 10_000n
 *   parseUsdc("189.37") => 189_370_000n
 */
export function parseUsdc(input: string | number): bigint {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`parseUsdc: invalid number: ${input}`);
    }
    input = input.toFixed(USDC_DECIMALS);
  }
  const s = String(input).trim();
  if (!s || s === ".") throw new Error(`parseUsdc: empty input`);
  if (s.startsWith("-")) throw new Error(`parseUsdc: negative: ${s}`);

  // accept optional leading + and a single dot
  const m = s.match(/^\+?(\d+)(?:\.(\d*))?$/);
  if (!m) throw new Error(`parseUsdc: malformed: "${s}"`);

  const intPart = m[1] ?? "0";
  let fracPart = m[2] ?? "";
  if (fracPart.length > USDC_DECIMALS) {
    throw new Error(
      `parseUsdc: too many decimals (max ${USDC_DECIMALS}): "${s}"`
    );
  }
  fracPart = fracPart.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);

  return BigInt(intPart) * ONE_USDC + BigInt(fracPart);
}

/**
 * Format a micro-USDC bigint back to a human-readable string with 6 decimals.
 * Returns e.g. "189.37" (trailing zeros trimmed from the fraction).
 * Uses ROUND_HALF_UP via toFixed on the integer cents — but since the input is
 * already integer micro-USDC, no rounding actually occurs here.
 */
export function formatUsdc(micro: bigint): string {
  if (micro < 0n) throw new Error(`formatUsdc: negative: ${micro}`);
  const whole = micro / ONE_USDC;
  const frac = micro % ONE_USDC;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

/** Trivial math helpers that stay in bigint. */
export function addUsdc(a: bigint, b: bigint): bigint {
  return a + b;
}
export function subUsdc(a: bigint, b: bigint): bigint {
  if (a < b) throw new Error(`subUsdc: underflow (${a} < ${b})`);
  return a - b;
}

/**
 * Compute `percent` of `micro` (micro-USDC). percent given in basis points to avoid float.
 * E.g. percentBps(micro, 200) = 2% of micro. 1% = 100 bps.
 */
export function percentBps(micro: bigint, bps: number): bigint {
  if (bps < 0) throw new Error(`percentBps: negative bps`);
  return (micro * BigInt(bps)) / 10_000n;
}
