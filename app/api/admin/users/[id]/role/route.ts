import { requireRole } from "@/lib/auth-ucw";
import { authErrorResponse, jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createMmAuditLog } from "@/lib/mm";

const VALID_ROLES = ["Member", "Buyer", "Seller", "Admin"] as const;

/** PATCH — change user role */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("Admin");
    const { id } = await params;
    if (id === user.id) return jsonError("Cannot change your own role", 400);

    const body = await req.json().catch(() => ({}));
    const newRole = String(body.role || "");
    if (!VALID_ROLES.includes(newRole as typeof VALID_ROLES[number])) {
      return jsonError("Invalid role. Must be one of: Member, Buyer, Seller, Admin", 400);
    }

    const admin = supabaseAdminClient();

    const { data: target } = await admin.from("users").select("role").eq("id", id).single();
    if (!target) return jsonError("User not found", 404);

    const oldRole = target.role;
    const { error } = await admin.from("users").update({ role: newRole }).eq("id", id);
    if (error) return jsonError(dbErrorMessage("admin/users/[id]/role", error), 500);

    // audit log
    let mmAction: string | null = null;
    if (newRole === "Admin" && oldRole !== "Admin") mmAction = "MM_PROMOTE";
    else if (oldRole === "Admin" && newRole !== "Admin") mmAction = "MM_DEMOTE";
    else if (oldRole === "Seller" && newRole === "Buyer") mmAction = "REVOKE_SELLER";

    if (mmAction) {
      await createMmAuditLog({
        mmUserId: user.id, mmWalletId: "system", actorType: "user",
        action: mmAction as "MM_PROMOTE" | "MM_DEMOTE" | "REVOKE_SELLER",
        refId: id, detail: { oldRole, newRole },
      });
    }

    await admin.from("audit_log").insert({
      actor_id: user.id, action: "APPROVE", ref: id,
      detail: { oldRole, newRole },
    });

    return jsonOk({ ok: true, role: newRole });
  } catch (e) {
    return authErrorResponse(e) ?? jsonError(
      e instanceof Error ? e.message : "role change failed", 500
    );
  }
}
