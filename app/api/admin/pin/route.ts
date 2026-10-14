import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { hashPin, verifyPin, getAdminPinHash, setAdminPinHash } from "@/lib/admin-auth";

/**
 * POST /api/admin/pin — Set or change admin PIN.
 *
 * Body (set first time): { pin: string }            (6-digit numeric)
 * Body (change):         { currentPin: string, pin: string }
 *
 * PIN requirements: 6 digits, numeric only.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const { pin, currentPin } = (body ?? {}) as { pin?: string; currentPin?: string };

  if (!pin || typeof pin !== "string") return jsonError("pin is required", 400);
  if (!/^\d{6}$/.test(pin)) return jsonError("PIN must be exactly 6 digits", 400);

  const existingHash = await getAdminPinHash(user.id);

  // If PIN already set, require current PIN to change
  if (existingHash) {
    if (!currentPin) return jsonError("currentPin required to change PIN", 400);
    const valid = await verifyPin(currentPin, existingHash);
    if (!valid) return jsonError("Current PIN is incorrect", 403);
  }

  const newHash = await hashPin(pin);
  await setAdminPinHash(user.id, newHash);

  return jsonOk({ ok: true, message: existingHash ? "PIN changed" : "PIN set" });
}

/**
 * GET /api/admin/pin — Check if admin has PIN set (no sensitive data returned).
 */
export async function GET() {
  let user;
  try {
    user = await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  const existingHash = await getAdminPinHash(user.id);
  return jsonOk({ hasPin: !!existingHash });
}
