import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdminClient } from '@/lib/supabase/admin-client';
import { getCurrentUser } from '@/lib/auth-ucw';

/**
 * .A — receipt rebuilt on the REAL schema.
 *
 * The previous version queried columns/relations that do not exist on
 * `orders`/`products` (buyers/sellers joins, unit_price, subtotal_amount,
 * admin_fee_amount, total_amount, quantity, seller_id, payment_method,
 * creation_tx_hash, delivery_type) → every request 500'd or produced $NaN
 * amounts, and sellers could never see their own receipt.
 *
 * Real columns (0001_init + 0027/0041): amount, buyer_fee, circle_fee,
 * gas_fee, qty, variant, payment, buyer_id, store_id, product_id, status,
 * on_chain_tx_hash.
 *
 * fee model: the buyer pays a 2% service fee on top, AND the seller has
 * 2% deducted at release — so the seller receives 98% of the item subtotal. The
 * receipt states both sides explicitly.
 */

interface ReceiptData {
  orderId: string;
  timestamp: string;
  buyerName: string;
  sellerName: string;
  productName: string;
  variant: string;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  /** Buyer-side service fee (2% of subtotal). */
  platformFee: string;
  /** What the seller actually receives: subtotal minus the 2% seller fee. */
  sellerReceives: string;
  totalPaid: string;
  paymentMethod: string;
  onChainTxHash: string;
  escrowContractAddress?: string;
  credentialsSummary: string;
  disclaimer: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const orderId = (await params).id;
    const admin = supabaseAdminClient();

    const { data: order, error: orderError } = await admin
      .from('orders')
      .select(`
        id, created_at, status, qty, variant, amount, buyer_fee, circle_fee, gas_fee,
        payment, buyer_id, store_id, product_id, on_chain_tx_hash,
        products(name, delivery),
        store:stores(name, owner_user_id)
      `)
      .eq('id', orderId)
      .maybeSingle();

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Supabase's client types embeds on to-one FKs as arrays even though the
    // REST payload returns an object; normalize both shapes defensively.
    const asOne = <T>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    const store = asOne((order as unknown as { store?: { name: string; owner_user_id: string } }).store);
    const product = asOne((order as unknown as { products?: { name: string; delivery: string } }).products);

    // Access control (real columns): buyer, the store's owner (seller), or admin.
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const isBuyer = currentUser.id === order.buyer_id;
    const isSeller = currentUser.id === store?.owner_user_id;
    const isAdmin = currentUser.role === 'Admin';
    if (!isBuyer && !isSeller && !isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized - only buyer and seller can access receipts' },
        { status: 403 }
      );
    }

    // Names via users lookups (best-effort; 'Anonymous' fallback keeps the
    // receipt generating even if a profile row is missing).
    const nameOf = async (userId: string | null | undefined): Promise<string> => {
      if (!userId) return 'Unknown';
      const { data } = await admin.from('users').select('name').eq('id', userId).maybeSingle();
      return data?.name || 'Unknown';
    };
    const [buyerName, sellerName] = await Promise.all([
      nameOf(order.buyer_id),
      nameOf(store?.owner_user_id),
    ]);

    const micro = (v: unknown): bigint => {
      try { return BigInt((v as string | number | null)?.toString() ?? '0'); } catch { return 0n; }
    };
    const usdc = (v: bigint): string => `$${(Number(v) / 1_000_000).toFixed(2)} USDC`;

    const amount = micro(order.amount);
    const qty = Math.max(1, Number(order.qty) || 1);
    const buyerFee = micro(order.buyer_fee);
    const total = amount + buyerFee + micro(order.circle_fee) + micro(order.gas_fee);
    const unitPrice = qty > 0 ? amount / BigInt(qty) : amount;
    // marketplace release deducts a 2% seller fee, so the seller's net
    // is not the subtotal. Mirrors the contract's computeSellerFee().
    const sellerFee = (amount * 200n) / 10000n;

    const credentialsSummary = product?.delivery === 'instant'
      ? 'Digital content delivered securely via encrypted escrow'
      : 'Manual delivery by seller';

    const receipt: ReceiptData = {
      orderId: order.id,
      timestamp: order.created_at,
      buyerName,
      sellerName,
      productName: product?.name || 'Unknown Product',
      variant: order.variant || 'Default',
      quantity: qty,
      unitPrice: usdc(unitPrice),
      subtotal: usdc(amount),
      platformFee: usdc(buyerFee),
      sellerReceives: usdc(amount - sellerFee),
      totalPaid: usdc(total),
      paymentMethod: order.payment || 'On-Chain Transfer',
      onChainTxHash: order.on_chain_tx_hash || 'Pending Confirmation',
      escrowContractAddress: process.env.ESCROW_CONTRACT_ADDRESS || 'N/A',
      credentialsSummary,
      disclaimer: 'This receipt serves as proof of purchase. For disputes, contact tribunal within 42 hours.'
    };

    const acceptHeader = req.headers.get('Accept');
    const pdfRequested = acceptHeader?.includes('application/pdf') ||
                        new URL(req.url).searchParams.get('format') === 'pdf';

    if (pdfRequested) {
      const pdfBuffer = await generateReceiptPDF(receipt);
      return new Response(pdfBuffer as BodyInit, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="slimemarket-receipt-' + orderId + '.pdf"',
        },
      });
    }

    return NextResponse.json({
      success: true,
      receipt,
      metadata: {
        generatedAt: new Date().toISOString(),
        version: '1.0.0',
        marketplace: 'SlimeMarket',
        currency: 'USDC',
        chain: 'ARC Testnet'
      }
    });

  } catch (error) {
    console.error('[Receipt] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate receipt' },
      { status: 500 }
    );
  }
}

async function generateReceiptPDF(receipt: ReceiptData): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf' as string) as unknown as { jsPDF: new () => any };
  const doc = new jsPDF();

  doc.setFontSize(20);
  doc.text('SLIMEMARKET RECEIPT', 20, 20);

  let y = 40;
  doc.setFontSize(12);
  doc.text(`Order ID: ${receipt.orderId}`, 20, y);
  y += 10;
  doc.text(`Date: ${new Date(receipt.timestamp).toLocaleString()}`, 20, y);
  y += 15;

  doc.text(`From: ${receipt.sellerName}`, 20, y);
  y += 10;
  doc.text(`To: ${receipt.buyerName}`, 20, y);
  y += 15;

  doc.text(`Item: ${receipt.productName} (${receipt.variant})`, 20, y);
  y += 10;
  doc.text(`Quantity: ${receipt.quantity}`, 20, y);
  y += 15;

  doc.text(`Subtotal: ${receipt.subtotal}`, 20, y);
  y += 10;
  doc.text(`Service Fee (2%, paid by buyer): ${receipt.platformFee}`, 20, y);
  y += 10;
  doc.text(`Seller Receives (after 2% fee): ${receipt.sellerReceives}`, 20, y);
  y += 10;
  doc.setFont("helvetica", "bold");
  doc.text(`Total Paid: ${receipt.totalPaid}`, 20, y);

  return doc.output('arraybuffer') as Uint8Array;
}
