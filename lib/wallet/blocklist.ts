import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { validateArcAddress } from "@/lib/arc";

/**
 * Check an Arc address against the on-chain blocklist.
 * Per ARC_INTEGRATION.md §5: always check destination before broadcast.
 * Returns true if address is blocklisted (withdraw must be rejected).
 */
export async function isBlocklisted(address: string): Promise<boolean> {
  let normalized: string;
  try {
    normalized = validateArcAddress(address).toLowerCase();
  } catch {
    return true; // invalid address = treat as blocked
  }

  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("blocklist_addresses")
    .select("address")
    .eq("address", normalized)
    .maybeSingle();

  if (error) {
    console.error("blocklist check failed:", error);
    return true; // P1-11 FIX: fail closed — block transaction if blocklist check fails
  }
  return !!data;
}
