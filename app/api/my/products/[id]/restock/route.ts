import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { z } from "zod";

export const dynamic = "force-dynamic";

const RestockSchema = z.object({
  variantLabel: z.string().min(1).max(200).optional().default("Default"),
  items: z.array(z.string().min(1)).optional(),
  stockQty: z.number().int().positive().optional(),
}).refine((b) => b.items?.length || b.stockQty, "items or stockQty required");

/**
 * POST /api/my/products/[id]/restock
 *
 * Restock a product (or a specific variant) with new stock items (instant delivery)
 * or a quantity (manual delivery).
 *
 * Body: { variantLabel?: string, items?: string[], stockQty?: number }
 *
 * For instant delivery: inserts items into product_stock_items with the given variant_label.
 * For manual delivery: increments products.stock.
 *
 * Auth: seller (owner of the product's store) or Admin.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const { id: productId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = RestockSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(`validation error: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`, 400);
  }

  const { variantLabel, items, stockQty } = parsed.data;
  const admin = supabaseAdminClient();

  // Verify product exists + user is the seller
  const { data: product } = await admin.from("products")
    .select("id, delivery, store_id, variants, status")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return jsonError("product not found", 404);

  const { data: store } = await admin.from("stores")
    .select("owner_user_id").eq("id", product.store_id).maybeSingle();
  if (!store || (store.owner_user_id !== user.id && user.role !== "Admin")) {
    return jsonError("not your product", 403);
  }

  const delivery = product.delivery as string;

  if (delivery === "instant" && items && items.length > 0) {
    // Insert per-variant stock items
    const rows = items.map(secret => ({
      product_id: productId,
      variant_label: variantLabel,
      secret: secret.trim(),
      status: "available",
    }));
    const { error } = await admin.from("product_stock_items").insert(rows);
    if (error) return jsonError(`insert failed: ${error.message}`, 500);

    // Also add to legacy stock_items array for backward compat
    try {
      await admin.rpc("append_stock_items", {
        p_product_id: productId,
        p_items: items,
      });
    } catch {
      // non-blocking — new table is source of truth
    }

    // Reactivate soldout products now that stock is available again.
    // (Fixes "restocked, but the status still shows 0 stock / stays soldout".)
    if (product.status === "soldout") {
      await admin.from("products").update({ status: "active" }).eq("id", productId);
    }

    return jsonOk({
      added: items.length,
      variantLabel,
      method: "instant_items",
    });
  }

  if (delivery === "manual" && stockQty) {
    const { error: incErr } = await admin.rpc("increment_stock", {
      p_product_id: productId,
      p_amount: stockQty,
    });
    if (incErr) {
      return jsonError(`update failed: ${incErr.message}`, 500);
    }

    // Reactivate soldout products now that stock is available again.
    if (product.status === "soldout") {
      await admin.from("products").update({ status: "active" }).eq("id", productId);
    }

    return jsonOk({
      added: stockQty,
      method: "manual_qty",
    });
  }

  return jsonError("no valid restock data", 400);
}
