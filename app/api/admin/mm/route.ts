import { gateRole } from "@/lib/api-gate";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { requireAdminAuth } from "@/lib/admin-auth";
import { createMmAuditLog } from "@/lib/mm";

/** GET — list current middlemen (Admin role check only, no PIN needed for read) */
export async function GET() {
  const gate = await gateRole("Admin");
  if (gate.error) return gate.error;
  const admin = supabaseAdminClient();
  const { data, error } = await admin.from("users").select("id, name, email, role").eq("role", "Admin");
  if (error) return jsonError(dbErrorMessage("admin/mm", error), 500);
  return jsonOk({ middlemen: data ?? [], escrowContract: process.env.ESCROW_CONTRACT_ADDRESS ?? null });
}

/** POST — promote user to Admin/MM (requires PIN + UCW) */
export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  const body = await req.json().catch(() => ({}));
  const userId = String(body.userId ?? "");
  if (!userId) return jsonError("userId required", 400);

  const admin = supabaseAdminClient();
  const { error } = await admin.from("users")
    .update({ role: "Admin" })
    .eq("id", userId);
  if (error) return jsonError(dbErrorMessage("admin/mm", error), 500);

  await createMmAuditLog({
    mmUserId: user.id, mmWalletId: "system", actorType: "user",
    action: "MM_PROMOTE", refId: userId,
  });

  return jsonOk({ ok: true, message: "Middleman added" });
}

/** DELETE — demote MM back to Buyer (requires PIN + UCW) */
export async function DELETE(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  const body = await req.json().catch(() => ({}));
  const userId = String(body.userId ?? "");
  if (!userId) return jsonError("userId required", 400);
  if (userId === user.id) return jsonError("Cannot remove yourself as middleman", 400);

  const admin = supabaseAdminClient();
  const { error } = await admin.from("users")
    .update({ role: "Buyer" })
    .eq("id", userId);
  if (error) return jsonError(dbErrorMessage("admin/mm", error), 500);

  await createMmAuditLog({
    mmUserId: user.id, mmWalletId: "system", actorType: "user",
    action: "MM_DEMOTE", refId: userId,
  });

  return jsonOk({ ok: true, message: "Middleman removed" });
}
