/**
 * Design Utilities — Date formatting, currency formatting, CN helper
 * Based on date-fns and existing money formatting
 */

import { format as formatDateFns, formatDistanceToNow } from 'date-fns';
import type { FormatDistanceOptions } from 'date-fns';

// USDC has 6 decimals (micro-USDC)
const USDC_DECIMALS = 6;
const ONE_USDC = 10n ** BigInt(USDC_DECIMALS); // 1_000_000

/**
 * Convert micro-USDC bigint to human-readable string with $ prefix
 * Example: 847500n → "$847.50"
 */
export function formatUsdc(microAmount: bigint): string {
  const amount = Number(microAmount) / Math.pow(10, USDC_DECIMALS);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Parse human-readable USDC string to micro-USDC bigint
 * Example: "$847.50" → 847500n
 */
export function parseUsdc(input: string | number): bigint {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`parseUsdc: invalid number: ${input}`);
    }
    return BigInt(Math.round(input * Math.pow(10, USDC_DECIMALS)));
  }

  // Remove non-numeric chars except decimal point
  const cleaned = input.replace(/[^\d.]/g, '');
  const parts = cleaned.split('.');

  if (parts.length > 2) {
    throw new Error(`Invalid USDC format: ${input}`);
  }

  const whole = parts[0] || '0';
  const fraction = (parts[1] || '').padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);

  try {
    return BigInt(whole + fraction);
  } catch {
    throw new Error(`Invalid USDC value: ${input}`);
  }
}

/**
 * Format ISO date string to localized format
 * Example: "2025-08-11T14:30:00Z" → "Aug 11, 2025"
 */
export function formatDate(isoDate: string): string {
  try {
    return formatDateFns(new Date(isoDate), 'MMM dd, yyyy');
  } catch {
    return isoDate;
  }
}

/**
 * Format ISO date relative to now
 * Example: "2025-08-11T12:30:00Z" → "2 hours ago"
 */
export function formatRelative(isoDate: string, options?: FormatDistanceOptions): string {
  try {
    return formatDistanceToNow(new Date(isoDate), { addSuffix: true, ...options });
  } catch {
    return isoDate;
  }
}

/**
 * Format timestamp to time-only display
 * Example: "2025-08-11T14:30:00Z" → "2:30 PM"
 */
export function formatTime(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  } catch {
    return '--:--';
  }
}

/**
 * Create a percentage change indicator
 * Example: +38% ↑ or -12% ↓ or 0% →
 */
export function formatPercentageChange(current: number, previous: number): {
  value: string;
  isPositive: boolean;
  symbol: string;
} {
  if (previous === 0) {
    return { value: `${current} `, isPositive: true, symbol: '↑' };
  }

  const change = ((current - previous) / previous) * 100;
  const rounded = Math.round(change * 10) / 10;

  return {
    value: rounded.toFixed(1),
    isPositive: rounded >= 0,
    symbol: rounded > 0 ? '↑' : rounded < 0 ? '↓' : '→',
  };
}

/**
 * Truncate string for display
 * Example: "abc123..." → "abc123" (with ellipsis if too long)
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

/**
 * Add leading zeros to numbers
 * Example: 5 → "05"
 */
export function padZero(num: number, length: number): string {
  return num.toString().padStart(length, '0');
}

export default {
  formatUsdc,
  parseUsdc,
  formatDate,
  formatRelative,
  formatTime,
  formatPercentageChange,
  truncate,
  padZero,
};
