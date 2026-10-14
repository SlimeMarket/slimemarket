import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { provisionVirtualStore } from "@/lib/catalog/virtual-store";
import type { CurrentUser } from "@/lib/auth-ucw";

/** Promote Member→Buyer after 3+ DONE transactions (idempotent). */
export async function promoteIfEligible(userId: string): Promise<string> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin.rpc("promote_role_if_eligible", { p_user_id: userId });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Apply for Seller role. Manual admin review based on account behavior
 * and public profile info only.
 *
 * .C1 — storeName is IGNORED (no more separate store concept; approval
 * derives the store from the user's username). The column is NOT NULL so we
 * persist a placeholder; nothing downstream reads it for store creation.
 */
export async function applySeller(user: CurrentUser, input: {
  storeName?: string; category?: string; pitch?: string; contact?: string;
}) {
  const admin = supabaseAdminClient();
  // check existing pending
  const { data: existing } = await admin.from("seller_applications")
    .select("id").eq("user_id", user.id).eq("status", "pending").maybeSingle();
  if (existing) throw new Error("already have a pending application");

  const { error } = await admin.from("seller_applications").insert({
    user_id: user.id,
    // Column kept NOT NULL; storeName is legacy/ignored since .C1.
    store_name: input.storeName?.trim() || user.username || user.name || "seller",
    category: input.category ?? null,
    note: [input.pitch, input.contact ? `contact:${input.contact}` : null]
      .filter(Boolean).join(" | ") || null,
  });
  if (error) throw new Error(error.message);
}

/** Admin approve → promote Seller, auto-provision the VIRTUAL STORE derived
 * from the user's identity, write audit_log.
 *
 * .C1 — the store row is no longer created from the application's
 * store_name; it is derived from the users row (name = username, handle =
 * '@'+username, uid = user uid). Idempotent + self-healing.
 */
export async function approveApplication(appId: string, adminUserId: string) {
  const admin = supabaseAdminClient();
  const { data: app } = await admin.from("seller_applications")
    .select("user_id, store_name").eq("id", appId).eq("status", "pending").maybeSingle();
  if (!app) throw new Error("application not found or already processed");

  // promote user to Seller
  await admin.from("users").update({ role: "Seller" }).eq("id", app.user_id);
  // auto-provision the virtual store derived FROM THE USER (idempotent).
  await provisionVirtualStore(app.user_id);
  // update application
  await admin.from("seller_applications").update({
    status: "approved", reviewed_by: adminUserId,
  }).eq("id", appId);
  // audit_log
  await admin.from("audit_log").insert({
    actor_id: adminUserId, action: "APPROVE", ref: appId,
    detail: { virtual_store: true, user_id: app.user_id },
  });
}

/** Admin reject → write audit_log. */
export async function rejectApplication(appId: string, adminUserId: string) {
  const admin = supabaseAdminClient();
  const { data: app } = await admin.from("seller_applications")
    .select("user_id, store_name").eq("id", appId).eq("status", "pending").maybeSingle();
  if (!app) throw new Error("application not found or already processed");
  await admin.from("seller_applications").update({
    status: "rejected", reviewed_by: adminUserId,
  }).eq("id", appId);
  await admin.from("audit_log").insert({
    actor_id: adminUserId, action: "REJECT", ref: appId,
    detail: { store_name: app.store_name, user_id: app.user_id },
  });
}

/** List pending applications (admin). */
export async function listApplications() {
  const admin = supabaseAdminClient();
  const { data, error } = await admin.from("seller_applications")
    .select("id, store_name, category, note, user_id, created_at, users!seller_applications_user_id_fkey(name, avatar_gradient)")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => {
    const u = (r.users as Record<string, unknown>) ?? {};
    return {
      id: r.id, storeName: r.store_name, category: r.category, note: r.note,
      userId: r.user_id, createdAt: r.created_at,
      userName: u.name as string ?? "Unknown", userAvatar: u.avatar_gradient as string ?? "from-slate-600 to-slate-800",
    };
  });
}
