import { createBrowserClient } from "@supabase/ssr";

/** Browser-side client for client components. */
export function createBrowserClient_() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    // .B — accept either anon-key env name (see lib/supabase/server.ts).
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
