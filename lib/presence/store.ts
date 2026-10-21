import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * Presence: write path.
 *
 * One UPDATE per heartbeat. Called from POST /api/presence, which the SPA pings
 * on boot, every 60s while the tab is visible, and when the tab regains focus.
 */
export async function touchPresence(userId: string, at: Date = new Date()): Promise<void> {
  if (!userId) return;
  const admin = supabaseAdminClient();
  const { error } = await admin
    .from("users")
    .update({ last_seen_at: at.toISOString() })
    .eq("id", userId);
  if (error) throw new Error(`touchPresence failed: ${error.message}`);
}

/**
 * Batch read for catalog joins (many sellers at once).
 * Missing rows simply do not appear in the map → callers treat them as offline.
 */
export async function lastSeenByUserIds(
  userIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("id, last_seen_at")
    .in("id", ids);
  if (error) return out; // presence is decorative — never fail a page over it

  for (const row of data ?? []) {
    out.set(row.id as string, (row.last_seen_at as string | null) ?? null);
  }
  return out;
}
