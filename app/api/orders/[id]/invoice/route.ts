import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdminClient } from '@/lib/supabase/admin-client';
import { getCurrentUser } from '@/lib/auth-ucw';
import { buildInvoiceData, renderInvoiceHtml } from '@/lib/order/invoice';

/**
 * GET /api/orders/[id]/invoice
 *
 * Browser-viewable HTML invoice for an order. Reuses the same renderer and
 * totals as the emailed invoice (`lib/order/invoice.ts`) so the two never
 * disagree. Opening it in a tab gives the user a printable document
 * (Ctrl+P → Save as PDF).
 *
 * ACCESS CONTROL: identical to /api/orders/[id]/receipt — buyer, the store
 * owner (seller), or admin.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const orderId = (await params).id;
    const admin = supabaseAdminClient();

    const { data: order, error: orderError } = await admin
      .from('orders')
      .select(
        'id, created_at, qty, variant, amount, buyer_fee, payment, status, buyer_id, store_id, product_id, on_chain_order_id, on_chain_tx_hash, store:stores(name, owner_user_id), products(name)'
      )
      .eq('id', orderId)
      .maybeSingle();

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const asOne = <T,>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    const store = asOne((order as unknown as { store?: { name: string; owner_user_id: string } }).store);
    const product = asOne((order as unknown as { products?: { name: string } }).products);

    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const isBuyer = currentUser.id === order.buyer_id;
    const isSeller = currentUser.id === store?.owner_user_id;
    const isAdmin = currentUser.role === 'Admin';
    if (!isBuyer && !isSeller && !isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized - only buyer and seller can view invoices' },
        { status: 403 }
      );
    }

    let buyerEmail: string | null = null;
    if (order.buyer_id) {
      const { data: buyer } = await admin
        .from('users')
        .select('email')
        .eq('id', order.buyer_id)
        .maybeSingle();
      buyerEmail = (buyer?.email as string | undefined) ?? null;
    }

    const invoice = buildInvoiceData({
      order: order as unknown as Record<string, unknown>,
      productName: (product?.name as string | undefined) ?? null,
      storeName: (store?.name as string | undefined) ?? null,
      buyerEmail,
      escrowAddress: process.env.ESCROW_CONTRACT_ADDRESS ?? '',
      explorerBase: process.env.ARC_EXPLORER_URL || 'https://testnet.arcscan.app/tx/',
      appUrl: process.env.NEXT_PUBLIC_APP_URL || 'https://slimemarket.app',
      networkLabel:
        (process.env.ARC_CHAIN_ID ?? '') === '5042' ? 'Arc Mainnet' : 'Arc Testnet',
    });

    return new NextResponse(renderInvoiceHtml(invoice), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[invoice] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate invoice' },
      { status: 500 }
    );
  }
}
