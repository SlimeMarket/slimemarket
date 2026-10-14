import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

/**
 * arc-ecommerce-payments patterns, extracted as pure/typed helpers
 * so they are unit-testable without Supabase/Circle (TDD):
 *
 *   (a) bestEffortPersist  — post-tx DB persistence must never fail the request.
 *   (b) guardTransition    — status preflight: wrong status → 409, bad amount → 422.
 *   (c) lifecycle_events   — builder matching migration 0044 columns EXACTLY.
 *   (e) validateDraftForConfirm — server-held draft re-validation (anti-tamper).
 *
 * Correlation (pattern d) lives in lib/contracts/indexer.ts (correlateOrderEvent).
 * All money amounts are bigint micro-USDC; strings are only used at the DB edge.
 */

// ---------------------------------------------------------------------------
// (b) State-machine guards
// ---------------------------------------------------------------------------

/** Order statuses used across this codebase (orders.status text column). */
export type CheckoutStatus =
  | "PENDING"
  | "PROCESS"
  | "SENT"
  | "DONE"
  | "CANCELLED"
  | "DECLINED"
  | "DISPUTED"
  | "CONFIRMED"
  | "REFUNDED";

/** Checkout/order lifecycle actions the guards know about. */
export type CheckoutAction =
  | "prepare"
  | "challenge"
  | "confirm"
  | "release"
  | "refund"
  | "cancel";

/**
 * Typed API error carrying the HTTP status the route should return. Arc
 * pattern: preflight checks that turn cryptic on-chain reverts / DB constraint
 * errors into clean API errors with stable codes.
 */
export class ApiValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "ApiValidationError";
  }
}

/** Wrong-status transition → 409 with a stable error code. */
export class GuardConflictError extends ApiValidationError {
  constructor(
    public readonly action: CheckoutAction,
    public readonly current: string,
    public readonly expected: readonly CheckoutStatus[],
  ) {
    super(
      `order status ${current} cannot ${action} (expected one of: ${expected.join(", ")})`,
      "INVALID_ORDER_STATUS",
      409,
    );
    this.name = "GuardConflictError";
  }
}

/**
 * Preflight guard: asserts the order is in one of the expected statuses before
 * the given action proceeds. Throws GuardConflictError (409) otherwise.
 * Pure — no I/O. Used by checkout prepare/challenge/confirm and transitions.
 */
export function guardTransition(
  current: string,
  expected: readonly CheckoutStatus[],
  action: CheckoutAction,
): void {
  if (!expected.includes(current as CheckoutStatus)) {
    throw new GuardConflictError(action, current, expected);
  }
}

/**
 * Parse + validate a micro-USDC amount string. Throws ApiValidationError with
 * httpStatus 422 for zero/negative/non-numeric input, or for an amount that
 * exceeds `maxMicro` (e.g. a client-echoed amount bigger than the draft).
 * Pure — bigint throughout.
 */
export function validateMicroAmount(input: string, maxMicro?: bigint): bigint {
  let v: bigint;
  try {
    v = BigInt(input);
  } catch {
    throw new ApiValidationError(`invalid amount: ${input}`, "INVALID_AMOUNT", 422);
  }
  if (v <= 0n) {
    throw new ApiValidationError(`amount must be positive, got ${v}`, "INVALID_AMOUNT", 422);
  }
  if (maxMicro !== undefined && v > maxMicro) {
    throw new ApiValidationError(
      `amount ${v} exceeds draft amount ${maxMicro}`,
      "AMOUNT_EXCEEDS_DRAFT",
      422,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// (a) Best-effort persistence
// ---------------------------------------------------------------------------

export interface BestEffortResult<T> {
  ok: boolean;
  /** fn result on success; `fallback` (or null) on failure. */
  value: T | null;
  /** True when fn threw and the fallback was returned. */
  degraded: boolean;
  /** Error message when degraded (for logging/observability). */
  error?: string;
}

interface BestEffortOpts<T> {
  /** Returned (with degraded:true) when fn throws. Defaults to null. */
  fallback?: T | null;
  /** Injectable logger (defaults to the app pino logger). */
  logger?: { error: (ctx: object, msg: string) => void };
  /** Extra structured context merged into the error log line. */
  context?: Record<string, unknown>;
}

/**
 * Arc rule: once the on-chain/approve transaction is confirmed, a DB write
 * failure must NOT surface as a checkout failure — funds/state already moved.
 * Runs `fn`; on throw, logs with full context and returns the fallback instead
 * of rethrowing. Never throws itself.
 */
export async function bestEffortPersist<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: BestEffortOpts<T>,
): Promise<BestEffortResult<T>> {
  try {
    const value = await fn();
    return { ok: true, value, degraded: false };
  } catch (e) {
    const errMessage = e instanceof Error ? e.message : String(e);
    const log = opts?.logger ?? logger;
    try {
      log.error(
        { ...(opts?.context ?? {}), label, err: errMessage },
        `bestEffortPersist: ${label} failed after tx (degraded response)`,
      );
    } catch {
      /* logging must never fail the request either */
    }
    return {
      ok: false,
      value: opts?.fallback ?? null,
      degraded: true,
      error: errMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// (c) lifecycle_events — migration 0044 columns
// ---------------------------------------------------------------------------

/** The EXACT operation set from migration 0044's CHECK constraint. */
export const LIFECYCLE_OPERATIONS = [
  "CREATED",
  "AUTHORIZED",
  "FUNDS_LOCKED",
  "CAPTURED",
  "RELEASED",
  "REFUNDED",
  "VOIDED",
  "DISPUTED",
  "RESOLVED",
  "SHIPPED",
] as const;
export type LifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number];

/** Row shape matching public.lifecycle_events (0044) — insertable as-is. */
export interface LifecycleEventInsert {
  order_id: string;
  operation: LifecycleOperation;
  tx_hash: string | null;
  /** NUMERIC(20,6) USDC amount as decimal string (micro → 6dp). */
  amount: string | null;
  note: string | null;
}

/** Convert bigint micro-USDC to a NUMERIC(20,6)-safe decimal string. */
export function microToDecimalString(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${frac}`;
}

export interface BuildLifecycleInput {
  orderId: string;
  operation: string;
  txHash?: string | null;
  amountMicro?: bigint | null;
  note?: string | null;
}

/**
 * Build a lifecycle_events insert row. Validates the operation against the
 * 0044 CHECK constraint (throws on unknown ops so a bad insert can never hit
 * the DB mid-checkout). Checkout transitions that have no direct 0044 op
 * (PREPARED/CHALLENGED/ORDER_CREATED) are mapped onto a valid op by the
 * caller and preserved in `note` (e.g. "checkout-transition:CHALLENGED").
 */
export function buildLifecycleEvent(input: BuildLifecycleInput): LifecycleEventInsert {
  if (!LIFECYCLE_OPERATIONS.includes(input.operation as LifecycleOperation)) {
    throw new Error(
      `unknown lifecycle operation "${input.operation}" — must be one of ${LIFECYCLE_OPERATIONS.join(", ")} (migration 0044)`,
    );
  }
  if (!input.orderId) throw new Error("lifecycle event requires orderId");
  return {
    order_id: input.orderId,
    operation: input.operation as LifecycleOperation,
    tx_hash: input.txHash ?? null,
    amount:
      input.amountMicro !== undefined && input.amountMicro !== null
        ? microToDecimalString(input.amountMicro)
        : null,
    note: input.note ?? null,
  };
}

/** Minimal structural interface so tests can inject a fake admin client. */
export interface LifecycleAdmin {
  from(table: "lifecycle_events"): {
    insert(row: LifecycleEventInsert): PromiseLike<{
      error: { message: string } | null;
    }>;
  };
}

/**
 * Insert one lifecycle event row. Throws on DB error — callers MUST wrap this
 * in bestEffortPersist (a lifecycle row must never fail a money path).
 */
export async function writeLifecycleEvent(
  admin: LifecycleAdmin,
  input: BuildLifecycleInput,
): Promise<void> {
  const row = buildLifecycleEvent(input);
  const { error } = await admin.from("lifecycle_events").insert(row);
  if (error) throw new Error(`lifecycle insert failed: ${error.message}`);
}

/**
 * Best-effort lifecycle write with full context logging. Never throws.
 * `before` naming: callers must invoke this BEFORE updating orders.status so
 * realtime UI cannot race ahead of the data (arc pattern).
 */
export async function recordLifecycleEvent(
  admin: LifecycleAdmin,
  input: BuildLifecycleInput,
  context?: Record<string, unknown>,
): Promise<void> {
  await bestEffortPersist(
    `lifecycle:${input.operation}:${input.orderId}`,
    () => writeLifecycleEvent(admin, input),
    { logger, context: { ...context, orderId: input.orderId } },
  );
}

// ---------------------------------------------------------------------------
// (e) Server-held draft re-validation (anti-tamper)
// ---------------------------------------------------------------------------

/** The columns confirm must re-load from the DB — never trust client echoes. */
export interface DraftRow {
  id: string;
  buyer_id: string;
  amount: string;
  buyer_fee: string | null;
  status: string;
  on_chain_order_id: string | null;
}

export interface ConfirmDraftValidation {
  /** SERVER value — the only amount the relay may use. */
  itemAmountMicro: bigint;
  buyerFeeMicro: bigint;
  /** item + fee — what the buyer's approve must cover. */
  approveTotalMicro: bigint;
}

export interface ValidateDraftInput {
  draft: DraftRow;
  userId: string;
  /**
   * Optional client-echoed amount. If provided it must EQUAL the draft's
   * amount; any divergence is a tamper attempt → 422. The relay always uses
   * the server value regardless.
   */
  clientAmountMicro?: string;
}

/**
 * Confirm-time anti-tamper gate. Re-validates ownership, status, and amounts
 * from the SERVER-held draft row:
 *   - wrong owner → 403 NOT_ORDER_OWNER
 *   - status ≠ PENDING → 409 INVALID_ORDER_STATUS
 *   - negative/zero/garbage amounts → 422 INVALID_AMOUNT
 *   - client-echoed amount ≠ draft → 422 AMOUNT_MISMATCH
 * Returns the server-side bigint amounts that the createOrderFor relay MUST
 * use (never client input). Pure — no I/O.
 */
export function validateDraftForConfirm(input: ValidateDraftInput): ConfirmDraftValidation {
  const { draft, userId } = input;

  if (draft.buyer_id !== userId) {
    throw new ApiValidationError("not your order", "NOT_ORDER_OWNER", 403);
  }

  guardTransition(draft.status, ["PENDING"], "confirm");

  let itemAmountMicro: bigint;
  try {
    itemAmountMicro = validateMicroAmount(draft.amount);
  } catch (e) {
    // A corrupt draft must never be relayed.
    throw new ApiValidationError(
      `draft amount invalid: ${(e as Error).message}`,
      "INVALID_AMOUNT",
      422,
    );
  }

  const buyerFeeMicro = draft.buyer_fee === null ? 0n : validateMicroAmountSafe(draft.buyer_fee);

  if (input.clientAmountMicro !== undefined) {
    let echoed: bigint;
    try {
      echoed = BigInt(input.clientAmountMicro);
    } catch {
      throw new ApiValidationError("invalid client amount", "AMOUNT_MISMATCH", 422);
    }
    if (echoed !== itemAmountMicro) {
      throw new ApiValidationError(
        `client amount ${echoed} does not match draft amount ${itemAmountMicro}`,
        "AMOUNT_MISMATCH",
        422,
      );
    }
  }

  return {
    itemAmountMicro,
    buyerFeeMicro,
    approveTotalMicro: itemAmountMicro + buyerFeeMicro,
  };
}

/** Fee of 0 is legal (e.g. fee-waived); negatives/garbage are not. */
function validateMicroAmountSafe(input: string): bigint {
  let v: bigint;
  try {
    v = BigInt(input);
  } catch {
    throw new ApiValidationError(`draft buyer_fee invalid: ${input}`, "INVALID_AMOUNT", 422);
  }
  if (v < 0n) {
    throw new ApiValidationError(`draft buyer_fee negative: ${v}`, "INVALID_AMOUNT", 422);
  }
  return v;
}

/** Type helper for route handlers that receive an unknown thrown value. */
export function httpStatusOfError(e: unknown): number | null {
  return typeof (e as { httpStatus?: number })?.httpStatus === "number"
    ? (e as { httpStatus: number }).httpStatus
    : null;
}

/** Re-export so route handlers can type the injected admin client. */
export type AdminClient = SupabaseClient;
