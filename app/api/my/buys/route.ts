import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-ucw';
import { supabaseAdminClient } from '@/lib/supabase/admin-client';

export const dynamic = "force-dynamic";

/**
 * GET /api/my/buys
 * Fetch product purchase history for authenticated user
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const admin = supabaseAdminClient();

    // Get all orders where this user is the buyer.
    // BUG FIX: was querying non-existent columns (buyer_wallet_id, total_amount,
    // settled_at, settlement_tx_hash). The orders table uses buyer_id (references
    // users.id) and amount (bigint micro-USDC).
    const { data: purchases, error: ordersErr } = await admin
      .from('orders')
      .select(`
        id,
        amount,
        buyer_fee,
        status,
        created_at,
        sent_at,
        product_id,
        payer_address,
        payer_wallet_type,
        on_chain_status,
        on_chain_order_id,
        products(name, category, img_url),
        stores(name)
      `)
      .eq('buyer_id', user.id)
      // this used to return only DONE/SENT, so a refunded or cancelled
      // order vanished from the buyer's dashboard with no trace. Include the
      // terminal states so a refund is visible as a refund.
      // PENDING/PROCESS are included too: an order that is still being handled
      // is the one a buyer most wants to see, and it used to disappear from the
      // log until it reached SENT.
      .in('status', ['PENDING', 'PROCESS', 'DONE', 'SENT', 'CANCELLED', 'DECLINED', 'DISPUTED'])
      .order('created_at', { ascending: false })
      .limit(30);

    if (ordersErr) {
      console.error('[Buys API] DB query error:', ordersErr.message);
    }

    const formattedPurchases = (purchases || []).map(o => {
      // BUG FIX: this used to be
      //   Number(BigInt(amount) / 1000000n) + Number(BigInt(fee) / 1000000n)
      // BigInt division TRUNCATES, so every order below 1 USDC rendered as
      // "0.00 USDC" in the buying log (0.10 → 0/1e6 = 0). Sum in micro first,
      // divide once, as a float.
      const micro = BigInt(String(o.amount ?? "0")) + BigInt(String(o.buyer_fee ?? "0"));
      return {
        id: o.id,
        order_id: o.id,
        product_name: (o as any).products?.name || 'Unknown Product',
        product_img: (o as any).products?.img_url || null,
        category: (o as any).products?.category || 'General',
        store_name: (o as any).stores?.name || 'Seller',
        amount: Number(micro) / 1_000_000,
        // exact value for anything that needs precision (invoice, reconciliation)
        amountMicro: micro.toString(),
        status: o.status,
        timestamp: o.created_at,
        settledAt: (o as any).sent_at || null,
        // .D — payer attribution (migration 0050 columns).
        payerWalletType: o.payer_wallet_type ?? null,
        payerAddress: o.payer_address ?? null,
        // A refunded order is stored as CANCELLED (the indexer maps REFUNDED
        // → CANCELLED), so the UI cannot tell "money came back" from "never
        // paid" without these two fields.
        onChainStatus: (o as any).on_chain_status ?? null,
        onChainOrderId: (o as any).on_chain_order_id ?? null
      };
    });

    return NextResponse.json({
      success: true,
      buys: formattedPurchases
    });

  } catch (error) {
    console.error('[Buys API] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
