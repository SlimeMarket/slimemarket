import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { PRESENCE_ONLINE_WINDOW_MS } from "@/lib/presence/window";

/**
 * Platform-wide counters for the home page "pulse" widget.
 *
 * Every number here is a `head: true` count, so PostgREST sends `COUNT(*)`
 * without any rows back — four cheap queries instead of pulling tables into
 * memory just to measure them.
 *
 * Cached for a few seconds in module scope: the widget polls, and a cold
 * Supabase round-trip on every visitor's first paint is wasted work when the
 * numbers move by single digits per hour.
 */

export interface PlatformStats {
  /** Registered accounts, all roles. */
  members: number;
  /** Accounts that can list products (Seller + Admin). */
  sellers: number;
  /** Orders that reached DONE — money actually settled. */
  sales: number;
  /** Sessions that pinged within the presence window. */
  online: number;
  /** Total USDC that moved through settled orders, decimal. */
  volumeUsdc: number;
}

const CACHE_TTL_MS = 10_000;

let cache: { at: number; value: PlatformStats } | null = null;

export async function getPlatformStats(): Promise<PlatformStats> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const admin = supabaseAdminClient();
  const onlineCutoff = new Date(Date.now() - PRESENCE_ONLINE_WINDOW_MS).toISOString();

  const [membersRes, sellersRes, salesRes, onlineRes, volumeRes] = await Promise.all([
    admin.from("users").select("id", { count: "exact", head: true }),
    admin.from("users").select("id", { count: "exact", head: true }).in("role", ["Seller", "Admin"]),
    admin.from("orders").select("id", { count: "exact", head: true }).eq("status", "DONE"),
    admin.from("users").select("id", { count: "exact", head: true }).gt("last_seen_at", onlineCutoff),
    // Amounts only — a bounded slice is enough for a headline number, and an
    // unbounded scan would be the one thing on the home page that can get slow.
    admin.from("orders").select("amount").eq("status", "DONE").limit(5000),
  ]);

  const volumeMicro = (volumeRes.data ?? []).reduce(
    (sum, row) => sum + Number((row as { amount: string | number | null }).amount ?? 0),
    0,
  );

  const value: PlatformStats = {
    members: membersRes.count ?? 0,
    sellers: sellersRes.count ?? 0,
    sales: salesRes.count ?? 0,
    online: onlineRes.count ?? 0,
    volumeUsdc: Math.round(volumeMicro) / 1_000_000,
  };

  cache = { at: Date.now(), value };
  return value;
}
