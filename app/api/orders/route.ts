import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { checkoutOrder } from "@/lib/order/checkout";
import { listOrders } from "@/lib/order/queries";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { checkUserRateLimit, FINANCIAL_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, CheckoutBodySchema } from "@/lib/schemas";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);
  const items = await listOrders(user.id);
  return jsonOk({ items });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  // Per-user rate limit on checkout (financial endpoint)
  const rlErr = await checkUserRateLimit(user.id, "checkout", FINANCIAL_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }

  // Idempotency guard: if key provided, check for existing order with same key
  // BEFORE validating the rest of the body (cheap fast-path).
  const rawKey = (typeof body === "object" && body !== null && "idempotencyKey" in body
    ? String((body as Record<string, unknown>).idempotencyKey ?? "")
    : "") || req.headers.get("x-idempotency-key") || null;
  if (rawKey) {
    const admin = supabaseAdminClient();
    const { data: existing } = await admin.from("orders")
      .select("id").eq("idempotency_key", rawKey).maybeSingle();
    if (existing) {
      // Return the existing order — same response as original checkout
      const { getOrder } = await import("@/lib/order/queries");
      const order = await getOrder(existing.id as string);
      return jsonOk(order, 200);
    }
  }

  // Validate the body shape with zod. Rejects malformed productId UUIDs,
  // negative qty, etc. before they reach checkoutOrder → DB → on-chain calls.
  const parsed = parseBody(CheckoutBodySchema, body);
  if (parsed instanceof Response) return parsed;

  try {
    const order = await checkoutOrder(user, {
      productId: parsed.productId,
      variantLabel: parsed.variantLabel,
      qty: parsed.qty,
      payment: parsed.payment,
      idempotencyKey: rawKey,
    });
    return jsonOk(order, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "checkout failed";
    // Honour a typed status when the thrower set one (e.g. the
    // CUSTODIAL_RAIL_DISABLED 409 from checkoutOrder). Falling through to the
    // 500 below turned a deliberate, client-actionable refusal into an opaque
    // server error.
    const typed = (e as { httpStatus?: number }).httpStatus;
    const code = (e as { code?: string }).code;
    if (typeof typed === "number" && typed >= 400 && typed < 600) {
      return jsonError(msg, typed, code ? { code } : undefined);
    }
    return jsonError(msg, /insufficient|not found|must be/i.test(msg) ? 400 : 500);
  }
}
