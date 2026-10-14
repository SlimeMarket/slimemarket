import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { getOrder } from "@/lib/order/queries";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) return jsonError("order not found", 404);
  return jsonOk(order);
}
