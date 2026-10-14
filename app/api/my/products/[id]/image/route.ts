import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage , clientErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { uploadImageDataUrl, PRODUCT_IMAGE_BUCKET } from "@/lib/storage/upload";

/**
 * POST /api/my/products/[id]/image  (Seller/Admin)
 *
 * Set/replace a product's image. Body: { img: "<base64 data URL>" }.
 * Verifies the product belongs to the caller's store, uploads to Storage
 * (fallback: inline data URL), persists img_url, and returns { img }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.role !== "Seller" && user.role !== "Admin") {
    return jsonError("Seller role required", 403);
  }
  const { id } = await params;

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON body", 400); }
  const { img } = (body ?? {}) as { img?: string };
  if (!img) return jsonError("img (data URL) is required", 400);

  const admin = supabaseAdminClient();

  // Ownership check: product -> store -> owner must be the caller.
  const { data: prod } = await admin
    .from("products")
    .select("id, stores!inner ( owner_user_id )")
    .eq("id", id)
    .maybeSingle();
  const owner = (prod as { stores?: { owner_user_id?: string } } | null)?.stores?.owner_user_id;
  if (!prod || owner !== user.id) return jsonError("product not found", 404);

  try {
    const url = await uploadImageDataUrl(PRODUCT_IMAGE_BUCKET, `p/${id}`, img);
    const { error } = await admin.from("products").update({ img_url: url }).eq("id", id);
    if (error) return jsonError(dbErrorMessage("my/products/[id]/image", error), 500);
    return jsonOk({ img: url });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "image upload failed"), 400);
  }
}
