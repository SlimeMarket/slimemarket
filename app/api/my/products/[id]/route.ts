import { requireRole } from "@/lib/auth-ucw";
import { authErrorResponse, jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { sanitizeText } from "@/lib/sanitize";

/**
 * PATCH / DELETE /api/my/products/[id]
 *
 * sellers could not edit or remove a listing: only status, restock,
 * variants and image had routes, so a typo in the name/price/description was
 * permanent and a product could never be taken down. These two handlers close
 * that gap.
 *
 * Ownership is checked against the seller's own store; `requireRole("Member")`
 * admits everyone and the real gate is the store match below (same pattern as
 * the existing status route).
 */

async function loadOwnedProduct(userId: string, productId: string) {
  const admin = supabaseAdminClient();

  const { data: product, error } = await admin
    .from("products")
    .select("id, store_id, price, status, variants")
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error(`failed to load product: ${error.message}`);
  if (!product) return { error: jsonError("product not found", 404) } as const;

  const { data: store, error: sErr } = await admin
    .from("stores")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (sErr || !store) return { error: jsonError("no store found for seller", 404) } as const;
  if (product.store_id !== store.id) {
    return { error: jsonError("product does not belong to your store", 403) } as const;
  }

  return { admin, product } as const;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireRole("Member");
  } catch (e) {
    return authErrorResponse(e) ?? jsonError("unauthorized", 401);
  }
  const { id } = await params;

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON body", 400); }
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    const owned = await loadOwnedProduct(user.id, id);
    if ("error" in owned) return owned.error;
    const { admin, product } = owned;

    // Build the patch from only the fields that were actually sent, so a partial
    // edit cannot blank out everything else.
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (typeof b.name === "string") {
      const name = b.name.trim();
      if (!name) return jsonError("name cannot be empty", 400);
      patch.name = name.slice(0, 120);
    }
    if (typeof b.desc === "string") {
      const desc = sanitizeText(b.desc);
      if (desc.trim().length < 10) return jsonError("description must be at least 10 characters", 400);
      patch.desc = desc;
    }
    if (typeof b.category === "string" && b.category.trim()) patch.category = b.category.trim();
    if (typeof b.delivery === "string") {
      if (!["instant", "manual"].includes(b.delivery)) return jsonError("invalid delivery", 400);
      patch.delivery = b.delivery;
    }
    if (typeof b.warranty === "string") patch.warranty = sanitizeText(b.warranty);
    if (typeof b.notes === "string") patch.notes = sanitizeText(b.notes);
    if (typeof b.glyph === "string") patch.glyph = b.glyph;
    if (typeof b.gradient === "string") patch.gradient = b.gradient;

    if (b.price !== undefined) {
      const price = Number(b.price);
      // Money: a non-positive price would let a buyer check out for free.
      if (!Number.isFinite(price) || price <= 0) return jsonError("price must be greater than 0", 400);
      const priceMicro = Math.round(price * 1_000_000);
      patch.price = priceMicro;

      // FIX: the public product views (home / explore / product page) render the
      // price from the `variants` jsonb, NOT from `products.price`. Editing the
      // price here used to update only `products.price`, so every public view
      // kept showing the OLD price while the seller center showed the new one.
      // Keep the two in lock-step.
      const existing = Array.isArray(product.variants)
        ? (product.variants as { label?: string; price?: number | string }[])
        : [];
      if (existing.length === 0) {
        patch.variants = [{ label: "Default", price: priceMicro }];
      } else if (existing.length === 1) {
        patch.variants = [{ ...existing[0], label: existing[0]?.label || "Default", price: priceMicro }];
      } else {
        // Multi-variant product: the seller edits individual variants through the
        // variants editor, so only retarget the base 'Default' row if it exists.
        const idx = existing.findIndex((v) => (v?.label || "Default") === "Default");
        if (idx >= 0) {
          patch.variants = existing.map((v, i) => (i === idx ? { ...v, price: priceMicro } : v));
        }
      }
    }

    // Explicit variants payload (future-proofs the variants editor): accepts
    // decimal prices and stores them as micro-USDC.
    if (Array.isArray(b.variants)) {
      const rows = (b.variants as { label?: unknown; price?: unknown }[])
        .map((v) => ({
          label: String(v?.label ?? "Default").trim() || "Default",
          price: Math.round(Number(v?.price) * 1_000_000),
        }))
        .filter((v) => v.label && Number.isFinite(v.price) && v.price > 0);
      if (rows.length > 0) patch.variants = rows;
    }

    if (b.stock !== undefined) {
      const stock = Number(b.stock);
      if (!Number.isInteger(stock) || stock < 0) return jsonError("stock must be a non-negative integer", 400);
      patch.stock = stock;
    }

    const { error: upErr } = await admin.from("products").update(patch).eq("id", id);
    if (upErr) throw new Error(`failed to update product: ${upErr.message}`);

    return jsonOk({ success: true, id, updated: Object.keys(patch).filter(k => k !== "updated_at") });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to update product";
    return jsonError(msg, /required|must be|cannot be/i.test(msg) ? 400 : 500);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireRole("Member");
  } catch (e) {
    return authErrorResponse(e) ?? jsonError("unauthorized", 401);
  }
  const { id } = await params;

  try {
    const owned = await loadOwnedProduct(user.id, id);
    if ("error" in owned) return owned.error;
    const { admin } = owned;

    // A product with order history must NOT be hard-deleted — orders reference
    // it for receipts and dispute evidence. Deactivate instead so it disappears
    // from the storefront while history stays intact.
    const { count } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("product_id", id);

    if ((count ?? 0) > 0) {
      const { error } = await admin
        .from("products")
        .update({ status: "inactive", updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error(`failed to deactivate product: ${error.message}`);
      return jsonOk({
        success: true,
        id,
        deleted: false,
        deactivated: true,
        reason: `product has ${count} order(s) — deactivated instead of deleted so order history stays intact`,
      });
    }

    const { error } = await admin.from("products").delete().eq("id", id);
    if (error) throw new Error(`failed to delete product: ${error.message}`);

    return jsonOk({ success: true, id, deleted: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to delete product";
    return jsonError(msg, 500);
  }
}
