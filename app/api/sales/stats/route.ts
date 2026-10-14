import { getSalesRecap } from "@/lib/sales/recap";
import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";

export async function GET(req: Request) {
  // requireRole() throws with `.status` set (401 unauth / 403 wrong role).
  // It must stay inside the try so those map to a real status code instead of
  // escaping as a bare, bodyless 500.
  try {
    await requireRole("Admin");
    const url = new URL(req.url);
    const period = url.searchParams.get("period") === "monthly" ? "monthly" : "weekly";
    const recap = await getSalesRecap(period);
    return jsonOk(recap);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) {
      return jsonError(status === 401 ? "unauthorized" : "forbidden", status);
    }
    return jsonError(clientErrorMessage(e, "error"), 500);
  }
}
