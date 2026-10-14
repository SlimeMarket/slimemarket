import { getCurrentUser } from "@/lib/auth-ucw";
import { isWlStaff } from "@/lib/types";
import { jsonError, jsonOk } from "@/lib/utils";
import { getDeal } from "@/lib/wl/queries";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;
  const deal = await getDeal(id);
  if (!deal) return jsonError("deal not found", 404);
  // party-only (buyer/seller identity) OR staff (Admin/MM — 3)
  if (deal.buyerId !== user.id && deal.sellerId !== user.id && !isWlStaff(user.role)) {
    return jsonError("forbidden", 403);
  }
  return jsonOk(deal);
}
