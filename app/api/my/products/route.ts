import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { sanitizeText } from "@/lib/sanitize";
import { listMyProducts, createProduct, type CreateProductInput } from "@/lib/catalog/products";

/**
 * /api/my/products — seller's own products (role: Seller/Admin).
 *
 *   GET  → list products owned by the authenticated seller
 *   POST → publish a new product
 *          Body (decimal USDC price): { name, category, delivery, price, glyph?, gradient?, desc, notes?, stockItems?/stock? }
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  try {
    const items = await listMyProducts(user);
    return jsonOk({ items });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to list my products"), 500);
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  // Seller Center = Seller/Admin only (golden rule API_CONTRACT §8 #8).
  if (user.role !== "Seller" && user.role !== "Admin") {
    return jsonError("Seller role required to publish products", 403);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  const b = (body ?? {}) as Partial<CreateProductInput>;

  // Map + validate happens inside createProduct; route just passes through.
  try {
    const created = await createProduct(user, {
      name: b.name ?? "",
      category: b.category ?? "Digital Products",
      delivery: (b.delivery === "manual" ? "manual" : "instant"),
      price: Number(b.price ?? 0),
      glyph: b.glyph,
      gradient: b.gradient,
      img: b.img,
      desc: sanitizeText(b.desc ?? ""),
      notes: sanitizeText(b.notes),
      warranty: sanitizeText(b.warranty),
      stockItems: b.stockItems,
      stock: b.stock,
      variants: Array.isArray(b.variants) ? b.variants : undefined,
    });
    return jsonOk(created, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to create product";
    // Validation errors → 400; DB/permission errors → 500.
    const status = /required|must be|requires/i.test(msg) ? 400 : 500;
    return jsonError(msg, status);
  }
}
