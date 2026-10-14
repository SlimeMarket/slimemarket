import { getCurrentUser } from "@/lib/auth-ucw";
import { isWlStaff } from "@/lib/types";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { listDealsForUser, listAllDeals } from "@/lib/wl/queries";
import { createDeal } from "@/lib/wl/transitions";
import { parseBody, CreateWlDealBodySchema } from "@/lib/schemas";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);
  try {
    // 3 — staff (Admin OR MM) sees the full release/refund queue.
    const items = isWlStaff(user.role)
      ? await listAllDeals()
      : await listDealsForUser(user.id);
    return jsonOk({ items });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "list failed"), 500);
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }

  // Validate: listingId must be a UUID (feeds DB lookup), qty/unit positive.
  const parsed = parseBody(CreateWlDealBodySchema, body);
  if (parsed instanceof Response) return parsed;

  try {
    const dealId = await createDeal(user.id, {
      listingId: parsed.listingId,
      unit: parsed.unit,
      qty: parsed.qty,
      isOffer: parsed.isOffer,
    });
    return jsonOk({ id: dealId, status: "WAITING" }, 201);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "create deal failed"), 400);
  }
}
