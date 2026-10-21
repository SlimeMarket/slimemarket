import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk, clientErrorMessage } from "@/lib/utils";
import { touchPresence } from "@/lib/presence/store";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_ONLINE_WINDOW_MS } from "@/lib/presence/window";

/**
 * POST /api/presence — session heartbeat.
 *
 * The SPA calls this on boot, every PRESENCE_HEARTBEAT_MS while the tab is
 * visible, and again when the tab regains focus. Store pages then read
 * `users.last_seen_at` to decide whether to show "Online now" or
 * "Active 2h ago" — see lib/presence/window.ts for the derivation.
 *
 * Auth is required (the middleware already gates /api/*), because the only
 * thing this writes is "this specific user is here right now". A guest has no
 * identity to mark.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const now = new Date();
  try {
    await touchPresence(user.id, now);
  } catch (e) {
    // Presence is decorative. A failed heartbeat must never surface as an app
    // error, and it must never block the client — it will retry in 60s.
    return jsonError(clientErrorMessage(e, "presence update failed"), 500);
  }

  return jsonOk({
    online: true,
    lastSeenAt: now.toISOString(),
    heartbeatMs: PRESENCE_HEARTBEAT_MS,
    onlineWindowMs: PRESENCE_ONLINE_WINDOW_MS,
  });
}
