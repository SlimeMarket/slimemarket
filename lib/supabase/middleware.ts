import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session on every server request.
 * Adapted from arc-commerce/lib/supabase/middleware.ts.
 *
 * If Supabase env vars are not configured (e.g. dev without a DB), this is a
 * no-op passthrough — routes that need Supabase will surface a clear error
 * themselves, while public routes (health, webhook signature check) keep working.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY;
  if (!url || !key) {
    // No Supabase configured — pass through without touching the session.
    return supabaseResponse;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // IMPORTANT: getUser() validates the JWT. Don't use getSession() — that trusts the client.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No auth gate at middleware level yet for M0; routes check auth themselves.
  // (Keep the call so the session refresh runs.)
  void user;

  return supabaseResponse;
}
