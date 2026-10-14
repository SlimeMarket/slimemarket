import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { listListings, createListing } from "@/lib/wl/queries";

export async function GET(req: Request) {
  try {
    // A1 — optional ?side=WTS|WTB filter so the market can show both books.
    const url = new URL(req.url);
    const raw = url.searchParams.get("side");
    const side = raw === "WTS" || raw === "WTB" ? raw : undefined;
    const items = await listListings(side ? { side } : undefined);
    return jsonOk({ items });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "list failed"), 500);
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  // Member+ can list WL (per API_CONTRACT — not Seller-only)
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!b.project) return jsonError("project required", 400);
  if (!b.type) return jsonError("type required (mint/token_transfer/wallet_surrender/discord_surrender/wallet_submit)", 400);
  // A1 — direction. Defaults to WTS so every existing client keeps working.
  // Anything other than the two known values is rejected rather than coerced,
  // because a bad side silently flips who is buyer and who is seller.
  const rawSide = b.side;
  if (rawSide != null && rawSide !== "WTS" && rawSide !== "WTB") {
    return jsonError("side must be WTS or WTB", 400, { code: "INVALID_SIDE" });
  }
  const side = (rawSide as "WTS" | "WTB" | undefined) ?? "WTS";
  // Validate optional img: must be a data: or https: URL string, capped ~2MB
  let img: string | undefined;
  if (b.img != null) {
    if (typeof b.img !== "string" || !/^(data:|https?:)/.test(b.img) || b.img.length > 2_000_000) {
      return jsonError("invalid img (expected data: or https: URL, max ~2MB)", 400);
    }
    img = b.img;
  }
  try {
    const created = await createListing(user, {
      project: String(b.project),
      wlType: b.wlType as string | undefined,
      type: String(b.type),
      side,
      unitPrice: Number(b.unitPrice ?? 0),
      mintPrice: b.mintPrice as number | undefined,
      qty: Number(b.qty ?? 1),
      projectLink: b.projectLink as string | undefined,
      offer: b.offer as boolean | undefined,
      collateral: Boolean(b.collateral),
      desc: b.desc as string | undefined,
      glyph: b.glyph as string | undefined,
      gradient: b.gradient as string | undefined,
      img,
    });
    return jsonOk(created, 201);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "create failed"), 400);
  }
}
