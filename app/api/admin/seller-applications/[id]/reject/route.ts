import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { rejectApplication } from "@/lib/roles";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.role !== "Admin") return jsonError("Admin only", 403);
  const { id } = await params;
  try { await rejectApplication(id, user.id); return jsonOk({ status: "rejected" }); }
  catch (e) { return jsonError(clientErrorMessage(e, "reject failed"), 400); }
}
