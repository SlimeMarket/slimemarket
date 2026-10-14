import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseBody, WlDisputeEvidenceBodySchema } from "@/lib/schemas";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { appendDisputeEvidence } from "@/lib/wl/transitions";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * POST /api/wl/deals/[id]/dispute-evidence — the OTHER party files their side.
 *
 * WHY THIS ROUTE EXISTS
 * The party who raises a dispute is rarely the only one with something to say.
 * If only the claimant's account reaches the arbitrator, the brief is one-sided
 * and has to be distrusted — so both parties need a way to be heard before the
 * ruling, without touching the chain (the dispute is already frozen on-chain by
 * `flagDispute`; this only adds to the case file).
 *
 * Auth: buyer or seller of the deal. Status must be DISPUTED — evidence filed
 * after the middleman has already ruled is not evidence.
 *
 * Appends; it never replaces what the other side already filed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const rlErr = await checkUserRateLimit(user.id, "wl-dispute-evidence", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDisputeEvidenceBodySchema, body);
  if (parsed instanceof Response) return parsed;

  if (!parsed.reason && !parsed.evidence?.length) {
    return jsonError("nothing to file: supply a reason and/or at least one evidence entry", 400, {
      code: "EMPTY_SUBMISSION",
    });
  }

  try {
    await appendDisputeEvidence(dealId, user.id, {
      reason: parsed.reason ?? null,
      evidence: parsed.evidence ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "could not file evidence";
    return jsonError(msg, /not found|only|must|too many/i.test(msg) ? 400 : 500);
  }

  // Return the refreshed case file so the caller sees what the arbitrator will
  // see — including whether the other side has filed anything yet.
  const admin = supabaseAdminClient();
  const { data } = await admin.from("wl_deals")
    .select("dispute_reason, dispute_evidence, dispute_brief, dispute_brief_at")
    .eq("id", dealId).maybeSingle();

  return jsonOk({
    dealId,
    ok: true,
    disputeReason: data?.dispute_reason ?? null,
    disputeEvidence: data?.dispute_evidence ?? [],
    disputeBrief: data?.dispute_brief ?? null,
    disputeBriefAt: data?.dispute_brief_at ?? null,
  }, 201);
}
