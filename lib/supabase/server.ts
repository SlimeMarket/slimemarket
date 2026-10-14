import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side client bound to the current request's cookies.
 * Uses the publishable/anon key — respects RLS, user is the authenticated JWT subject.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    // .B — accept either anon-key env name (code + template drifted).
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — middleware refreshes the session instead.
          }
        },
      },
    }
  );
}
