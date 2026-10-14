/**
 * Role gate for API route handlers.
 *
 * WHY: `requireRole()` throws an Error carrying `.status` (401/403), but Next.js
 * route handlers have no global error→response mapper — an uncaught throw becomes
 * a generic **500**. That is wrong: an authenticated user hitting an admin route
 * must get **403**, and an anonymous caller **401**. It also masked the real
 * cause behind a 500 in the admin console.
 *
 * Usage (replaces a bare `await requireRole("Admin");`):
 *
 *   const gate = await gateRole("Admin");
 *   if (gate.error) return gate.error;
 *   // gate.user is the authenticated CurrentUser
 *
 * Any non-auth error (unexpected) is re-thrown so genuine bugs still surface as
 * 500 with a stack trace in the server log.
 */
import { requireRole } from "@/lib/auth-ucw";
import { jsonError } from "@/lib/utils";
import type { CurrentUser } from "@/lib/auth-ucw";
import type { Role } from "@/lib/types";

type GateResult =
  | { user: CurrentUser; error: null }
  | { user: null; error: Response };

export async function gateRole(min: Role): Promise<GateResult> {
  try {
    const user = await requireRole(min);
    return { user, error: null };
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 401) return { user: null, error: jsonError("unauthorized", 401) };
    if (status === 403) return { user: null, error: jsonError("forbidden", 403) };
    throw e;
  }
}
