import {
  createClient as createSupabaseClient,
  SupabaseClient,
} from "@supabase/supabase-js";

/**
 * Service-role admin client. Bypasses RLS. Server-side only.
 * Used for: webhook handlers, provisioning, scheduled jobs, admin ops.
 */
export function supabaseAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // .B — accept either service-role env name (SUPABASE_SECRET_KEY is the
  // canonical one used by .env.local; SUPABASE_SERVICE_ROLE_KEY is the name a
  // few call sites / the template referenced). Either works now.
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "supabaseAdminClient: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set"
    );
  }
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
