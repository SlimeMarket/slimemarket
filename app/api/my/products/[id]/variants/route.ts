import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { coerceVariants } from "@/lib/catalog/variant-price";

export const dynamic = "force-dynamic";

/**
 * PUT /api/my/products/[id]/variants
 *
 * Update the variants jsonb on an existing product. Allows adding/removing/changing
 * variants after product creation.
 *
 * Body: { variants: [{ label: string, price: number }] }
 * (price in decimal USDC, converted to micro internally)
 *
 * Auth: seller (owner of the product's store) or Admin.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const { id: productId } = await params;
  const body = await req.json().catch(() => ({}));
  const rawVariants = body.variants;

  if (!Array.isArray(rawVariants) || rawVariants.length === 0) {
    return jsonError("variants array required (at least 1)", 400);
  }

  // Verify ownership + fetch base price (fallback for empty variant prices).
  const admin = supabaseAdminClient();
  const { data: product } = await admin.from("products")
    .select("store_id, price").eq("id", productId).maybeSingle();
  if (!product) return jsonError("product not found", 404);

  const { data: store } = await admin.from("stores")
    .select("owner_user_id").eq("id", product.store_id).maybeSingle();
  if (!store || (store.owner_user_id !== user.id && user.role !== "Admin")) {
    return jsonError("not your product", 403);
  }

  // Base price is stored in micro-USDC (as string). Used as the fallback when
  // a variant's price is empty / non-numeric — previously an empty
  // price produced parseFloat("")=NaN → Math.round(NaN)=NaN → a $0 variant that
  // let buyers check out for free. Now empty/invalid → the product base price.
  const basePriceMicro = Math.round(Number(product.price ?? 0)) || 0;

  // Validate + convert to micro-USDC (decimal USDC in → micro out).
  const variants = coerceVariants(rawVariants, basePriceMicro);

  // Update variants
  const { error } = await admin.rpc("update_product_variants", {
    p_product_id: productId,
    p_variants: JSON.stringify(variants),
  });

  if (error) return jsonError(`update failed: ${error.message}`, 500);

  return jsonOk({ ok: true, variants });
}
