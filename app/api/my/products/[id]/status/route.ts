import { requireRole } from "@/lib/auth-ucw";
import { authErrorResponse, jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * PATCH /api/my/products/[id]/status
 * Update product status (active/soldout/inactive). Seller-only.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // requireRole takes a minimum rank; "Member" (rank 0) admits everyone —
  // actual seller gating happens via the store-ownership check below.
  // It throws (with .status) rather than returning a response, so it must be
  // caught here or an unauthenticated call leaks as a bodyless HTTP 500.
  let user;
  try {
    user = await requireRole("Member");
  } catch (e) {
    return authErrorResponse(e) ?? jsonError("unauthorized", 401);
  }
  const { id } = await params;

  try {
    const body = await req.json();
    const { status } = body;

    if (!status) {
      return jsonError("status is required", 400);
    }

    if (!["active", "soldout", "inactive"].includes(status)) {
      return jsonError("invalid status", 400);
    }

    const admin = supabaseAdminClient();

    // Verify this product belongs to this seller's store
    const { data: existingProduct, error: fetchErr } = await admin
      .from("products")
      .select("store_id")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) throw new Error(`Failed to fetch product: ${fetchErr.message}`);
    if (!existingProduct) {
      return jsonError("product not found", 404);
    }

    // Get the seller's store ID
    const { data: store, error: storeErr } = await admin
      .from("stores")
      .select("id")
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (storeErr || !store) {
      return jsonError("no store found for seller", 404);
    }

    // Validate ownership
    if (existingProduct.store_id !== store.id) {
      return jsonError("product does not belong to your store", 403);
    }

    // Update product status
    const { error: updateErr } = await admin
      .from("products")
      .update({ 
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateErr) throw new Error(`Failed to update status: ${updateErr.message}`);

    console.log(`[ProductStatus] Updated product ${id} status to ${status}`);

    return jsonOk({ 
      success: true, 
      message: `Product status changed to ${status}`,
      productId: id,
      newStatus: status
    });

  } catch (e) {
    console.error("[ProductStatus] Error:", e);
    return jsonError(clientErrorMessage(e, "failed to update status"), 500);
  }
}
