/**
 * Presence: pure helpers (no DB import).
 *
 * Kept separate from `./store.ts` so that mapping modules (lib/catalog/mappers)
 * can derive `online` without pulling the Supabase admin client into their
 * import graph.
 *
 * The model is deliberately dumb: we only store `users.last_seen_at` and treat
 * "online" as "pinged within ONLINE_WINDOW_MS". No socket, no presence table,
 * no reaper. A heartbeat every 60s keeps the window honest; a closed tab stops
 * pinging and the seller ages out on its own.
 */

/** A session counts as online if it pinged within this window. */
export const PRESENCE_ONLINE_WINDOW_MS = 120_000;

/** Heartbeat interval the client uses (kept in sync with public/app.jsx). */
export const PRESENCE_HEARTBEAT_MS = 60_000;

export interface Presence {
  online: boolean;
  lastSeenAt: string | null;
}

export function isOnline(
  lastSeenAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!lastSeenAt) return false;
  const t = Date.parse(lastSeenAt);
  if (Number.isNaN(t)) return false;
  const delta = now - t;
  // A clock skewed slightly into the future should still read as online, not
  // as "last seen in 1970".
  return delta <= PRESENCE_ONLINE_WINDOW_MS;
}

export function presenceOf(lastSeenAt: string | null | undefined): Presence {
  return {
    online: isOnline(lastSeenAt),
    lastSeenAt: lastSeenAt ?? null,
  };
}
