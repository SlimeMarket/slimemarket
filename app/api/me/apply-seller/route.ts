import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { applySeller } from "@/lib/roles";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  let body: unknown; try { body = await req.json(); } catch { body = {}; }
  const { storeName, category, pitch, contact } = (body ?? {}) as Record<string, unknown>;
  // .C1 — storeName is OPTIONAL (ignored at approval time: the virtual
  // store is derived from the user's username). Kept for backwards compat.
  try {
    await applySeller(user, {
      storeName: storeName ? String(storeName) : undefined,
      category: category as string | undefined,
      pitch: pitch as string | undefined, contact: contact as string | undefined,
    });
    return jsonOk({ status: "pending" }, 201);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "apply failed"), 400);
  }
}
