import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { listApplications } from "@/lib/roles";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "Admin") return jsonError("Admin only", 403);
  try {
    const items = await listApplications();
    return jsonOk({ items });
  } catch (e) { return jsonError(clientErrorMessage(e, "list failed"), 500); }
}
