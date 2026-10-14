import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/** Relative "time ago" label for the NotifBell. */
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  return d + "d";
}

/** GET /api/notifications — current user's notifications (newest first). */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("notifications")
    .select("id, icon, tone, title, text, read, link, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return jsonError(dbErrorMessage("notifications", error), 500);
  const items = (data ?? []).map((n) => ({
    id: n.id,
    icon: n.icon,
    tone: n.tone,
    title: n.title,
    text: n.text ?? "",
    read: n.read,
    go: n.link ?? null,
    time: relTime(n.created_at as string),
  }));
  return jsonOk({ items });
}

/** PATCH /api/notifications — mark all of the user's notifications read. */
export async function PATCH() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const admin = supabaseAdminClient();
  const { error } = await admin
    .from("notifications")
    .update({ read: true })
    .eq("user_id", user.id)
    .eq("read", false);
  if (error) return jsonError(dbErrorMessage("notifications", error), 500);
  return jsonOk({ ok: true });
}

/** DELETE /api/notifications — clear all of the user's notifications. */
export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const admin = supabaseAdminClient();
  const { error } = await admin.from("notifications").delete().eq("user_id", user.id);
  if (error) return jsonError(dbErrorMessage("notifications", error), 500);
  return jsonOk({ ok: true });
}
