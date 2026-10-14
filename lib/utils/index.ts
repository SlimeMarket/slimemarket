import { NextResponse } from "next/server";
import type { Role } from "@/lib/types";
import { ROLE_RANK } from "@/lib/types";

/**
 * JSON replacer that serializes `bigint` as a decimal string.
 *
 * viem/escrow reads return `bigint` (micro-USDC amounts, block numbers), and
 * `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`
 * otherwise. Stringifying keeps precision that `Number` would silently lose
 * for amounts > 2^53 micro-USDC (~9.0e15 micro ≈ 9 billion USDC).
 */
export function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Standard JSON error response (BigInt-safe). */
export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return new NextResponse(JSON.stringify({ error: message, ...extra }, bigintReplacer), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Standard JSON success response (BigInt-safe). */
export function jsonOk(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data, bigintReplacer), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Phrases that only ever originate from Postgres / PostgREST, never from app
 * code. Used to catch driver text that has been WRAPPED into a plain Error
 * (e.g. `throw new Error(\`create_wl_deal: ${rpcErr.message}\`)`), which would
 * otherwise look exactly like an app-authored message.
 */
const DRIVER_ERROR_SIGNS: RegExp[] = [
  /violates .*constraint/i,
  /duplicate key value/i,
  /permission denied for/i,
  /row-level security policy/i,
  /syntax error at or near/i,
  /null value in column/i,
  /invalid input syntax/i,
  /\bPGRST\d+/,
  /\bpg_[a-z_]+/i,
  /relation "[^"]+" does not exist/i,
  /column "[^"]+" does not exist/i,
];

/** True when the error is structurally a PostgREST/Circle driver error. */
function looksLikeDriverError(err: Record<string, unknown>): boolean {
  // PostgREST attaches these; app errors never do.
  if ("details" in err || "hint" in err) return true;

  const code = err.code;
  if (typeof code === "number") return true;                    // Circle SDK
  if (typeof code === "string") {
    // SQLSTATE ("23505", "42501") or PostgREST ("PGRST116").
    if (/^[0-9A-Z]{5}$/.test(code) || /^PGRST\d+$/.test(code)) return true;
  }
  return false;
}

/**
 * Turn a caught error into a message that is safe to send to the CLIENT.
 *
 * WHY THIS EXISTS
 * Routes returned `e.message` verbatim, which leaked raw driver output —
 * Postgres/PostgREST constraint names, column names and SQL fragments
 * (`duplicate key value violates unique constraint "users_email_key"`). Useful
 * to someone mapping the schema, noise to a user.
 *
 * WHY IT IS NOT A BLANKET "RETURN A GENERIC STRING"
 * The app ALSO throws deliberate, user-facing errors — "insufficient on-chain
 * balance: have 0.27, need 0.56", "seller has no on-chain wallet". Those must
 * reach the caller or the UI becomes unexplainable. They are the overwhelming
 * majority: lib/wl/transitions.ts alone has 69 throws and only 6 set a marker,
 * so an "only show marked errors" rule would silently swallow ~63 real messages.
 *
 * SO: allow by default, BLOCK what is provably driver output — either by shape
 * (PostgREST `details`/`hint`, SQLSTATE/Circle `code`) or by content (a driver
 * phrase wrapped into a plain Error). An explicit `httpStatus` marker is
 * honoured as "definitely ours".
 */
export function clientErrorMessage(e: unknown, fallback = "request failed"): string {
  const err = e as (Record<string, unknown> & { message?: unknown; httpStatus?: unknown }) | null | undefined;

  if (!err || typeof err !== "object") {
    console.error("[api] non-error thrown (withheld from client):", e);
    return fallback;
  }

  const message = typeof err.message === "string" ? err.message : "";
  if (!message) {
    console.error("[api] error without a message (withheld from client):", e);
    return fallback;
  }

  // Explicitly ours — always safe.
  if (typeof err.httpStatus === "number") return message;

  if (looksLikeDriverError(err) || DRIVER_ERROR_SIGNS.some((re) => re.test(message))) {
    // Keep the full detail server-side; hand the caller a generic string.
    console.error("[api] driver error withheld from client:", message);
    return fallback;
  }

  return message;
}

/**
 * Log a database/PostgREST error and return a generic message.
 *
 * For the `if (error) return …` branches of Supabase calls, where the error is
 * ALWAYS internal: there is no version of
 * `violates check constraint "wl_deals_status_check"` a client should see.
 */
export function dbErrorMessage(context: string, err: unknown, fallback = "database error"): string {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
  console.error(`[api] ${context} failed:`, msg);
  return fallback;
}

/**
 * Map an error thrown by `requireUser()` / `requireRole()` to a JSON response.
 *
 * `requireRole` throws an `Error` with a numeric `.status` (401 unauth, 403
 * wrong role) instead of returning a response. When that call sits *outside*
 * a try/catch — as it did in `admin/**\/freeze`, `admin/users/[id]/ban`,
 * `admin/users/[id]/role`, `my/products/[id]` and `sales/stats` — Next.js
 * renders its generic error page and the client sees a **bodyless HTTP 500**
 * instead of the correct 401/403.
 *
 * Usage:
 *   try {
 *     const user = await requireRole("Admin");
 *     ...
 *   } catch (e) {
 *     return authErrorResponse(e) ?? jsonError("...", 500);
 *   }
 *
 * Returns `null` when the error is not an auth error, so the caller can fall
 * through to its own error handling.
 */
export function authErrorResponse(e: unknown): NextResponse | null {
  const status = (e as { status?: number } | null)?.status;
  if (status === 401) return jsonError("unauthorized", 401);
  if (status === 403) return jsonError("forbidden", 403);
  return null;
}

/**
 * Generate an 8-char uppercase public UID (e.g. "FRST9K2X").
 * Collisions are caught at the DB unique constraint; caller should retry.
 */
export function generateUid(prefix = ""): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return prefix + s;
}

/** Generate an order id like "SLM-69E11226". */
export function generateOrderId(prefix = "SLM"): string {
  const hex = Math.random().toString(16).slice(2, 10).toUpperCase();
  return `${prefix}-${hex}`;
}

/** Generate a WL deal id like "WL-A41C9X". */
export function generateDealId(): string {
  const hex = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `WL-${hex}`;
}

/** Generate a rekber id like "RKB-A41C9". */
export function generateRekberId(): string {
  const hex = Math.random().toString(16).slice(2, 7).toUpperCase();
  return `RKB-${hex}`;
}

/**
 * Censor a display name for reviews (privacy). Mirrors frontend censorName.
 *   - len <= 3: first char + '*' * (len-1)
 *   - len > 3: first 3 chars + '*' * min(7, len-3)
 * Example: "shadowmint" -> "sha*******"
 */
export function censorName(name: string | null | undefined): string {
  if (!name) return "";
  const s = String(name);
  if (s.length <= 3) {
    return s[0] + "*".repeat(Math.max(1, s.length - 1));
  }
  return s.slice(0, 3) + "*".repeat(Math.min(7, s.length - 3));
}

/** Check role rank without importing the enum everywhere. */
export function hasRoleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
