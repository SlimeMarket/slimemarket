import { NextRequest } from "next/server";
import { jsonOk, jsonError } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth-ucw";
import { createMmAuditLog } from "@/lib/mm";
import {
  RECOVERY_PURPOSES,
  buildRecoveryMessage,
  consumeNonce,
  linkRecoveryWallet,
  listRecoveryWallets,
  recoveryDomainFromRequest,
  unlinkRecoveryWallet,
  verifyRecoverySignature,
} from "@/lib/auth/recovery";

/**
 * /api/me/recovery-wallet (session-auth)
 *
 * Manage the external EOAs that can recover this account when the email is
 * lost. Linking requires proof of control: the client must first call
 * /api/auth/recovery/challenge with purpose 'link_wallet' (session required)
 * and sign the returned message with the EOA being linked.
 *
 * GET    → { wallets: [{ id, address, chainId, label, linkedAt, lastUsedAt }] }
 * POST   { address, nonce, signature } → link (201) / 400|401|403|409
 * DELETE { address } → unlink (200)
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  try {
    return jsonOk({ wallets: await listRecoveryWallets(user.id) });
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const address = String(body.address ?? "").trim();
  const nonce = String(body.nonce ?? "").trim();
  const signature = String(body.signature ?? "").trim();
  const label = body.label ? String(body.label).slice(0, 40) : null;
  if (!address || !nonce || !signature) return jsonError("address, nonce and signature are required", 400);

  // Proof of control: consume the link nonce and verify the signature over the
  // exact message the server issued (issued_at from the DB row, never client).
  const consumed = await consumeNonce({
    nonce,
    purpose: RECOVERY_PURPOSES.LINK,
    address,
  });
  if (!consumed.ok || !consumed.issuedAt) {
    return jsonError("invalid or expired challenge — request a new one", 400);
  }
  // A link nonce is only usable by the signed-in account it was issued to.
  if (consumed.userId !== user.id) {
    return jsonError("challenge does not belong to this session", 403);
  }

  const message = buildRecoveryMessage({
    domain: recoveryDomainFromRequest(req),
    address,
    nonce,
    issuedAt: consumed.issuedAt,
    purpose: RECOVERY_PURPOSES.LINK,
  });
  if (!(await verifyRecoverySignature({ address, message, signature }))) {
    return jsonError("signature does not match the wallet", 400);
  }

  const linked = await linkRecoveryWallet({ userId: user.id, address, label });
  if (!linked.ok) return jsonError(linked.error, linked.status);

  await createMmAuditLog({
    mmUserId: user.id,
    mmWalletId: "recovery",
    actorType: "user",
    action: "RECOVERY_WALLET_LINK",
    refId: user.id,
    detail: { address: address.toLowerCase(), label },
  }).catch(() => { /* best-effort; login path never depends on audit */ });

  return jsonOk({ ok: true, address: address.toLowerCase() }, 201);
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const address = String(body.address ?? "").trim();
  if (!address) return jsonError("address is required", 400);

  try {
    const removed = await unlinkRecoveryWallet({ userId: user.id, address });
    if (!removed) return jsonError("recovery wallet not found", 404);
    await createMmAuditLog({
      mmUserId: user.id,
      mmWalletId: "recovery",
      actorType: "user",
      action: "RECOVERY_WALLET_UNLINK",
      refId: user.id,
      detail: { address: address.toLowerCase() },
    }).catch(() => {});
    return jsonOk({ ok: true });
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}
