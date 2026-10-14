import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { listSellerOrders } from "@/lib/order/queries";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const items = await listSellerOrders(user.id);
  return jsonOk({ items });
}
