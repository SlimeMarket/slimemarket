import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-ucw';
import { isCronSecretAuthorized } from '@/lib/utils/cron-auth';
import { supabaseAdminClient } from '@/lib/supabase/admin-client';
import { releaseOrderOnChain } from '@/lib/contracts/escrow-client';
import { waitForCircleTxState } from '@/lib/wallet/circle-tx-status';
import { createMmAuditLog } from '@/lib/mm';
import { logger } from '@/lib/logger';

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/:id/auto-release
 * Automatically settle completed orders to seller's wallet via DCW relayer.
 *
 * v4 fee model: the contract handles the payout — `releaseOrder` deducts the
 * 2% seller fee (`SELLER_FEE_BPS = 200`) and transfers `amount − 2%` to the
 * seller; the 2% buyer fee was already collected at creation. Backend just
 * relays `releaseOrder(orderId)` via the platform DCW wallet (which is also the
 * operator/middleman).
 *
 * Flow:
 *   1. Validate order status DONE/RELEASED, not already settled.
 *   2. DCW relayer calls `releaseOrder(onChainOrderId)`.
 *   3. Poll Circle tx state until CONFIRMED/FAILED.
 *   4. On CONFIRMED: update orders.settled_at + settlement_tx_hash + status='RELEASED'.
 *   5. On FAILED: leave pending, audit log, reconcile job backstop.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // .A — auth gate (was MISSING: any logged-in user could settle ANY
    // order). Either the cron secret (Authorization: Bearer or ?cron_secret=,
    // timing-safe) or an Admin session — same pattern as /api/admin/auto-release.
    if (!isCronSecretAuthorized(req, process.env.INDEXER_CRON_SECRET)) {
      try {
        await requireRole("Admin");
      } catch {
        return NextResponse.json(
          { error: 'Unauthorized: admin session or cron secret required' },
          { status: 401 },
        );
      }
    }

    const orderId = (await params).id;

    // Get order details with seller wallet
    const admin = supabaseAdminClient();

    const { data: order, error: orderErr } = await admin
      .from('orders')
      .select(`
        id,
        status,
        amount,
        buyer_fee,
        on_chain_order_id,
        on_chain_tx_hash,
        settled_at,
        settlement_tx_hash,
        store:stores(
          owner_user_id,
          owner_wallet_address:users(wallets(address))
        )
      `)
      .eq('id', orderId)
      .maybeSingle();

    if (orderErr || !order) {
      console.error('[AutoRelease] Order not found:', orderErr);
      return NextResponse.json(
        { error: 'Order not found' },
        { status: 404 }
      );
    }

    // Check if order is DONE but not yet settled.
    // `'RELEASED'` used to be accepted here too, but the status CHECK never
    // allowed that value, so no row can carry it — the branch was dead.
    if (order.status !== 'DONE') {
      return NextResponse.json(
        { error: 'Order not ready for auto-release' },
        { status: 400 }
      );
    }

    // Idempotency: already settled
    if (order.settled_at && order.settlement_tx_hash) {
      console.log(`[AutoRelease] Already settled: ${orderId}`);
      return NextResponse.json({
        success: true,
        alreadySettled: true,
        txHash: order.settlement_tx_hash
      });
    }

    // Must have an on-chain order id (created at checkout via createOrderFor)
    const onChainOrderId = order.on_chain_order_id as string | null;
    if (!onChainOrderId) {
      console.error('[AutoRelease] No on_chain_order_id for order:', orderId);
      return NextResponse.json(
        { error: 'Order has no on-chain escrow id — cannot release' },
        { status: 400 }
      );
    }

    // Use the platform DCW wallet as the relayer (operator + middleman)
    const platformWalletId = process.env.PLATFORM_CIRCLE_WALLET_ID ?? '';

    // Step 1: Relay releaseOrder via DCW
    logger.info({ orderId, onChainOrderId }, 'auto-release: relaying releaseOrder');

    const result = await releaseOrderOnChain(onChainOrderId, platformWalletId);
    if (!result) {
      throw new Error('releaseOrderOnChain returned null — contract not ready');
    }

    const circleTxId = result.id;

    // Step 2: Poll Circle tx state until terminal
    const state = await waitForCircleTxState(circleTxId, { timeoutMs: 60_000 });

    if (state !== 'CONFIRMED' && state !== 'COMPLETE') {
      // FAILED / CANCELLED / DENIED / timeout
      // Leave order pending — reconcile job will backstop
      await createMmAuditLog({
        mmUserId: null,
        mmWalletId: platformWalletId,
        actorType: 'auto_release',
        action: 'RELEASE_ORDER',
        refId: orderId,
        circleTxId,
        detail: {
          reason: 'tx_not_confirmed',
          state: state ?? 'timeout',
          onChainOrderId,
        },
      }).catch(() => {});

      return NextResponse.json(
        {
          error: `Release tx did not confirm (state: ${state ?? 'timeout'}). Reconcile will resolve.`,
          circleTxId,
        },
        { status: 502 }
      );
    }

    // Step 3: CONFIRMED — update order with settlement data
    // v4 contract: releaseOrder transfers `amount − 2%` to the seller (the
    // contract deducts SELLER_FEE_BPS; the 2% buyer fee was already collected at
    // creation). No fee math needed here — the chain is authoritative.

    // BUG FIX: this wrote status 'RELEASED', which the orders_status_check
    // constraint does not allow (PENDING | PROCESS | SENT | DONE | DISPUTED |
    // CANCELLED | DECLINED). The update would have been rejected even after the
    // missing settlement columns were added. 'DONE' is the terminal released
    // state — it is what the buyer-confirm path and auto-settlement both use.
    const { error: updateErr } = await admin
      .from('orders')
      .update({
        status: 'DONE',
        settled_at: new Date().toISOString(),
        settlement_tx_hash: circleTxId,
        auto_released: true,
      })
      .eq('id', orderId);

    if (updateErr) {
      console.error('[AutoRelease] DB update error:', updateErr);
      return NextResponse.json(
        { error: 'Failed to update order status' },
        { status: 500 }
      );
    }

    // Step 4: Audit log
    await admin.from('audit_log').insert({
      actor_id: null, // System action
      action: 'AUTO_RELEASE',
      ref: orderId,
      detail: {
        circleTxId,
        onChainOrderId,
        amount: order.amount,
        type: 'auto-release-success',
      }
    });

    await createMmAuditLog({
      mmUserId: null,
      mmWalletId: platformWalletId,
      actorType: 'auto_release',
      action: 'RELEASE_ORDER',
      refId: orderId,
      circleTxId,
      detail: {
        onChainOrderId,
        amount: String(order.amount),
        type: 'auto-release',
      },
    }).catch(() => {});

    logger.info({ orderId, circleTxId }, 'auto-release: success');

    return NextResponse.json({
      success: true,
      txHash: circleTxId,
      onChainOrderId,
      message: 'Order released to seller on-chain'
    });

  } catch (error) {
    console.error('[AutoRelease] Unexpected error:', error);
    const err = error as Error;
    return NextResponse.json(
      { error: 'Auto-settlement failed', detail: err.message },
      { status: 500 }
    );
  }
}
