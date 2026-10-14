import { requireRole } from "@/lib/auth-ucw";
import { authErrorResponse, jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createMmAuditLog } from "@/lib/mm";

/** POST — freeze store + all its products */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("Admin");
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const reason = String(body.reason || "");

    const admin = supabaseAdminClient();

    const { data: store } = await admin.from("stores").select("id").eq("id", id).single();
    if (!store) return jsonError("Store not found", 404);

    // freeze store
    const { error } = await admin.from("stores").update({
      frozen: true, frozen_reason: reason || null,
      frozen_by: user.id, frozen_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return jsonError(dbErrorMessage("admin/stores/[id]/freeze", error), 500);

    // freeze all products in store
    const { data: frozenProducts } = await admin.from("products").update({
      frozen: true, frozen_reason: reason || null,
      frozen_by: user.id, frozen_at: new Date().toISOString(),
    }).eq("store_id", id).select("id");

    const productsFrozen = frozenProducts?.length ?? 0;

    await admin.from("audit_log").insert({
      actor_id: user.id, action: "FREEZE", ref: id,
      detail: { reason, type: "store", productsFrozen },
    });
    await createMmAuditLog({
      mmUserId: user.id, mmWalletId: "system", actorType: "user",
      action: "FREEZE_STORE", refId: id,
      detail: { reason, productsFrozen },
    });

    return jsonOk({ ok: true, productsFrozen });
  } catch (e) {
    return authErrorResponse(e) ?? jsonError(
      e instanceof Error ? e.message : "freeze store failed", 500
    );
  }
}

/** DELETE — unfreeze store + all its products */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("Admin");
    const { id } = await params;

    const admin = supabaseAdminClient();

    const { error } = await admin.from("stores").update({
      frozen: false, frozen_reason: null,
    }).eq("id", id);
    if (error) return jsonError(dbErrorMessage("admin/stores/[id]/freeze", error), 500);

    const { data: unfrozenProducts } = await admin.from("products").update({
      frozen: false, frozen_reason: null,
    }).eq("store_id", id).select("id");

    const productsUnfrozen = unfrozenProducts?.length ?? 0;

    await createMmAuditLog({
      mmUserId: user.id, mmWalletId: "system", actorType: "user",
      action: "UNFREEZE_STORE", refId: id,
      detail: { productsUnfrozen },
    });

    return jsonOk({ ok: true, productsUnfrozen });
  } catch (e) {
    return authErrorResponse(e) ?? jsonError(
      e instanceof Error ? e.message : "unfreeze store failed", 500
    );
  }
}
