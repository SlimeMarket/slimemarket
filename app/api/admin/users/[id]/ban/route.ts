import { requireRole } from "@/lib/auth-ucw";
import { authErrorResponse, jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createMmAuditLog } from "@/lib/mm";
import { setWalletFrozen } from "@/lib/circle/wallet-freeze";

/** POST — ban user */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("Admin");
    const { id } = await params;
    if (id === user.id) return jsonError("Cannot ban yourself", 400);

    const body = await req.json().catch(() => ({}));
    const reason = String(body.reason || "");
    const until = body.until ? String(body.until) : null;

    const admin = supabaseAdminClient();

    // check target exists + get current role
    const { data: target } = await admin.from("users").select("role").eq("id", id).single();
    if (!target) return jsonError("User not found", 404);

    // ban + revoke seller if applicable
    const updates: Record<string, unknown> = {
      banned: true,
      banned_reason: reason || null,
      banned_by: user.id,
      banned_until: until,
    };
    if (target.role === "Seller") updates.role = "Buyer";

    const { error } = await admin.from("users").update(updates).eq("id", id);
    if (error) return jsonError(dbErrorMessage("admin/users/[id]/ban", error), 500);

    // Best-effort: freeze the user's Circle wallet at the infra layer so a
    // banned user can't drain funds even with a stolen session. Non-blocking —
    // DB ban is the source of truth; wallet freeze is defense-in-depth.
    let walletFreezeResult: { ok: boolean; error?: string } | null = null;
    try {
      const { data: wallet } = await admin.from("wallets")
        .select("circle_wallet_id").eq("user_id", id).maybeSingle();
      if (wallet?.circle_wallet_id) {
        walletFreezeResult = await setWalletFrozen(wallet.circle_wallet_id, true);
      }
    } catch (e) {
      walletFreezeResult = { ok: false, error: (e as Error).message };
    }

    // audit logs
    await admin.from("audit_log").insert({
      actor_id: user.id, action: "BAN", ref: id,
      detail: { reason, until, revokedSeller: target.role === "Seller", walletFreezeResult },
    });
    await createMmAuditLog({
      mmUserId: user.id, mmWalletId: "system", actorType: "user",
      action: "BAN_USER", refId: id,
      detail: { reason, until, walletFreezeResult },
    });
    // Separate audit row for the wallet freeze (WALLET_FREEZE action) so the
    // action is independently queryable in the audit viewer.
    await createMmAuditLog({
      mmUserId: user.id, mmWalletId: "system", actorType: "user",
      action: "WALLET_FREEZE", refId: id,
      detail: { reason, walletFreezeResult, circleWalletId: walletFreezeResult?.ok ? "frozen" : "n/a" },
    }).catch(() => {});

    return jsonOk({ ok: true, walletFreezeResult });
  } catch (e) {
    return authErrorResponse(e) ?? jsonError(
      e instanceof Error ? e.message : "ban failed", 500
    );
  }
}

/** DELETE — unban user */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("Admin");
    const { id } = await params;

    const admin = supabaseAdminClient();
    const { error } = await admin.from("users").update({
      banned: false, banned_reason: null, banned_by: null, banned_until: null,
    }).eq("id", id);
    if (error) return jsonError(dbErrorMessage("admin/users/[id]/ban", error), 500);

    // Best-effort: unfreeze the wallet to restore functionality.
    let walletUnfreezeResult: { ok: boolean; error?: string } | null = null;
    try {
      const { data: wallet } = await admin.from("wallets")
        .select("circle_wallet_id").eq("user_id", id).maybeSingle();
      if (wallet?.circle_wallet_id) {
        walletUnfreezeResult = await setWalletFrozen(wallet.circle_wallet_id, false);
      }
    } catch (e) {
      walletUnfreezeResult = { ok: false, error: (e as Error).message };
    }

    await createMmAuditLog({
      mmUserId: user.id, mmWalletId: "system", actorType: "user",
      action: "UNBAN_USER", refId: id,
      detail: { walletUnfreezeResult },
    });
    await createMmAuditLog({
      mmUserId: user.id, mmWalletId: "system", actorType: "user",
      action: "WALLET_UNFREEZE", refId: id,
      detail: { walletUnfreezeResult },
    }).catch(() => {});

    return jsonOk({ ok: true, walletUnfreezeResult });
  } catch (e) {
    return authErrorResponse(e) ?? jsonError(
      e instanceof Error ? e.message : "unban failed", 500
    );
  }
}
