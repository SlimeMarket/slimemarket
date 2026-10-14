import { jsonError, jsonOk } from "@/lib/utils";
import { requireAdminAuth } from "@/lib/admin-auth";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { parseUsdc, formatUsdc } from "@/lib/money";
import { createMmAuditLog } from "@/lib/mm";
import { parseBody, TreasuryAirdropBodySchema } from "@/lib/schemas";

/**
 * POST /api/admin/treasury/airdrop
 *
 * Airdrop rewards from treasury to top spenders/sellers.
 * Requires admin auth token (PIN + UCW verified).
 *
 * Body: {
 *   recipients: Array<{ userId: string, amountUsdc: string }>,
 *   memo: string  // e.g. "Top seller reward July 2026"
 * }
 *
 * Max 20 recipients per batch. Each gets credited individually with audit trail.
 */
export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }

  // Validate body. Rejects non-UUID userIds, malformed amounts, oversized batches.
  const parsed = parseBody(TreasuryAirdropBodySchema, body);
  if (parsed instanceof Response) return parsed;

  // Convert amounts to micro once (schema already validated positivity).
  const items: Array<{ userId: string; amountMicro: bigint }> = parsed.recipients.map((r) => ({
    userId: r.userId,
    amountMicro: parseUsdc(r.amountUsdc),
  }));

  const admin = supabaseAdminClient();
  const results: Array<{ userId: string; amount: string; status: string }> = [];

  for (const { userId, amountMicro } of items) {
    // Get recipient wallet
    const { data: wallet } = await admin
      .from("wallets")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!wallet) {
      results.push({ userId, amount: formatUsdc(amountMicro), status: "failed: no wallet" });
      continue;
    }

    // Insert wallet_tx
    const { data: txRow, error: txErr } = await admin
      .from("wallet_txs")
      .insert({
        wallet_id: wallet.id,
        type: "in",
        label: "Airdrop reward",
        sub: parsed.memo,
        amount: amountMicro,
        status: "pending",
        method: "internal",
        idempotency_key: crypto.randomUUID(),
      })
      .select("id")
      .single();

    if (txErr || !txRow) {
      results.push({ userId, amount: formatUsdc(amountMicro), status: "failed: tx insert" });
      continue;
    }

    // Credit wallet
    const { error: creditErr } = await admin.rpc("credit_wallet_atomic", {
      p_wallet_id: wallet.id,
      p_amount: amountMicro.toString(),
      p_ref_id: txRow.id,
      p_wallet_tx_id: txRow.id,
      p_holding_hours: 0,
    });

    if (creditErr) {
      results.push({ userId, amount: formatUsdc(amountMicro), status: `failed: ${creditErr.message}` });
      continue;
    }

    results.push({ userId, amount: formatUsdc(amountMicro), status: "done" });
  }

  // Audit log (single entry for batch)
  const totalMicro = items.reduce((sum, r) => sum + r.amountMicro, 0n);
  await createMmAuditLog({
    mmUserId: user.id,
    mmWalletId: "treasury",
    actorType: "user",
    action: "TREASURY_AIRDROP",
    refId: `batch-${Date.now()}`,
    metadata: {
      recipientCount: items.length,
      totalAmount: formatUsdc(totalMicro),
      memo: parsed.memo,
      results,
    },
  });

  const succeeded = results.filter(r => r.status === "done").length;
  return jsonOk({
    ok: true,
    total: items.length,
    succeeded,
    failed: items.length - succeeded,
    results,
  });
}
