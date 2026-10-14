import { requireRole } from "@/lib/auth-ucw";
import { authErrorResponse, jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createMmAuditLog } from "@/lib/mm";

/** POST — freeze product */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("Admin");
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const reason = String(body.reason || "");

    const admin = supabaseAdminClient();

    const { data: product } = await admin.from("products").select("id").eq("id", id).single();
    if (!product) return jsonError("Product not found", 404);

    const { error } = await admin.from("products").update({
      frozen: true, frozen_reason: reason || null,
      frozen_by: user.id, frozen_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return jsonError(dbErrorMessage("admin/products/[id]/freeze", error), 500);

    await admin.from("audit_log").insert({
      actor_id: user.id, action: "FREEZE", ref: id, detail: { reason, type: "product" },
    });
    await createMmAuditLog({
      mmUserId: user.id, mmWalletId: "system", actorType: "user",
      action: "FREEZE_PRODUCT", refId: id, detail: { reason },
    });

    return jsonOk({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? jsonError(
      e instanceof Error ? e.message : "freeze failed", 500
    );
  }
}

/** DELETE — unfreeze product */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("Admin");
    const { id } = await params;

    const admin = supabaseAdminClient();
    const { error } = await admin.from("products").update({
      frozen: false, frozen_reason: null,
    }).eq("id", id);
    if (error) return jsonError(dbErrorMessage("admin/products/[id]/freeze", error), 500);

    await createMmAuditLog({
      mmUserId: user.id, mmWalletId: "system", actorType: "user",
      action: "UNFREEZE_PRODUCT", refId: id,
    });

    return jsonOk({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? jsonError(
      e instanceof Error ? e.message : "unfreeze failed", 500
    );
  }
}
