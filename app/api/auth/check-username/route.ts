import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/check-username?username=xxx
 * Check if a username is available.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const username = (searchParams.get("username") || "").trim().toLowerCase();

  if (!username || username.length < 3 || username.length > 20) {
    return jsonError("username must be 3-20 characters", 400);
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    return jsonError("username can only contain lowercase letters, numbers, and underscores", 400);
  }

  const admin = supabaseAdminClient();
  const { data } = await admin.from("users")
    .select("id").eq("username", username).maybeSingle();

  return jsonOk({ available: !data });
}
