/**
 * Supabase Client Separation - Service Role Pattern
 * Inspired by Circle Fin Arc Ecommerce Three-Tier Client Architecture
 */

import { createClient as supabaseCreateClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Environment variables (must be set)
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY; // Service role key (ADMIN level)
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required Supabase environment variables');
}

/**
 * SERVICE ROLE CLIENT
 * Bypasses Row Level Security (RLS) - Full database access
 * Used for: Webhooks, background jobs, admin operations
 * NEVER use in client components or route handlers that accept user input
 */
export function createServiceClient(): SupabaseClient {
  return supabaseCreateClient(
    SUPABASE_URL!,
    SUPABASE_SERVICE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}

/**
 * SERVER CLIENT (Server Components/Route Handlers)
 * Subject to RLS based on auth cookies
 * Used for: Protected routes where user identity is known
 */
export async function createServerClient() {
  // For Next.js App Router, we rely on server-side session context
  // The middleware sets up proper cookies for Supabase auth
  
  return supabaseCreateClient(
    SUPABASE_URL!,
    SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}

/**
 * BROWSER CLIENT (Client Components)
 * Subject to RLS - never trust the client
 * Used for: Frontend data fetching via hooks like useQuery
 */
export function createBrowserDb() {
  return supabaseCreateClient(
    SUPABASE_URL!,
    SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: true // Browser can persist session
      }
    }
  );
}

// Export helper for different contexts
export const db = {
  /** Get service role client (no auth required) */
  getServiceClient: () => createServiceClient(),
  
  /** Get authenticated server client */
  getServerClient: () => createServerClient(),
  
  /** Get browser client (requires auth cookie) */
  getClient: () => createBrowserDb(),
};

// Convenience re-exports for common usage patterns
export const createSupabaseClient = db.getServerClient;
export const createSupabaseAdminClient = db.getServiceClient;
