/**
 * Catalog mappers: DB rows (bigint micro-USDC) → frontend API shape (decimal USDC).
 *
 * The frontend (data.jsx/storefront.jsx) expects DECIMAL USDC numbers everywhere
 * (Usdc component does `(189).toLocaleString(... {fractionDigits:2})`). The DB
 * stores bigint micro-USDC (6 decimals). These helpers convert at the boundary
 * and rename DB columns to the FE field names (e.g. avatar_gradient → avatar).
 */

import { parseUsdc } from "@/lib/money";
import { isOnline } from "@/lib/presence/window";

const ONE_USDC = 1_000_000n;

/** micro-USDC bigint/number/string → decimal USDC number (e.g. 189000000 → 189). */
export function microToDecimal(micro: bigint | number | string | null | undefined): number {
  if (micro == null) return 0;
  const b = typeof micro === "bigint" ? micro : BigInt(micro);
  return Number(b) / Number(ONE_USDC);
}

/** decimal USDC number (e.g. 189) → micro-USDC bigint. */
export function decimalToMicro(dec: number | string): bigint {
  return parseUsdc(typeof dec === "number" ? dec.toFixed(6) : String(dec));
}

/** A single price inside a variants jsonb (micro) → FE decimal. */
interface VariantRow {
  label: string;
  price: number | string;
}
function mapVariant(v: VariantRow) {
  return { label: v.label, price: microToDecimal(v.price) };
}

/**
 * Product row (joined with store + owner) → frontend shape.
 * - name → title, category → cat
 * - price (micro) → decimal
 * - variants: if jsonb has entries, map each (micro→decimal);
 *   else synthesize [{label:'Default', price: decimal(price)}]
 * - seller: embedded {name, rating, avatar} from the store join
 */
export interface ProductApiRow {
  id: string;
  title: string;
  cat: string;
  delivery: "instant" | "manual";
  price: number;
  variants: { label: string; price: number; stock: number }[];
  desc: string;
  gradient: string | null;
  glyph: string | null;
  img: string | null;
  status: string;
  stockItems: string[];
  variantStock: Record<string, number>;
  stock: number;
  sold: number;
  views: number;
  hot: boolean;
  est: number;
  warranty: string;
  joined: string;
  priceLow: number;
  priceHigh: number;
  seller: { name: string; rating: number; avatar: string; online: boolean; lastSeenAt: string | null };
}

export function mapProduct(row: {
  id: string;
  name: string;
  category: string | null;
  delivery: string;
  price: string | number | bigint;
  variants: VariantRow[] | null;
  desc: string;
  gradient: string | null;
  glyph: string | null;
  img_url?: string | null;
  status: string;
  stock_items: string[] | null;
  variant_stocks?: Record<string, number> | null;
  stock: number;
  sold: number;
  views: number;
  hot: boolean;
  est: number;
  store_name?: string | null;
  store_rating?: number | string | null;
  store_avatar?: string | null;
  store_avatar_url?: string | null;
  store_last_seen?: string | null;
  joined?: string | null;
  warranty?: string | null;
}): ProductApiRow {
  const priceDecimal = microToDecimal(row.price);
  const variantStockMap = row.variant_stocks ?? {};
  const rawVariants = Array.isArray(row.variants) ? row.variants : [];
  const variants = rawVariants.length > 0
    ? rawVariants.map(v => ({
        label: v.label,
        price: microToDecimal(v.price),
        stock: variantStockMap[v.label] ?? 0,
      }))
    : [{
        label: "Default",
        price: priceDecimal,
        stock: variantStockMap["Default"] ?? row.stock_items?.length ?? row.stock ?? 0,
      }];
  return {
    id: row.id,
    title: row.name,
    cat: row.category ?? "Digital Products",
    delivery: row.delivery as "instant" | "manual",
    price: priceDecimal,
    variants,
    desc: row.desc,
    gradient: row.gradient,
    glyph: row.glyph,
    img: row.img_url ?? null,
    status: row.status,
    stockItems: row.stock_items ?? [],
    variantStock: variantStockMap,
    stock: row.stock,
    sold: row.sold,
    views: row.views,
    hot: row.hot,
    est: row.est,
    warranty: row.warranty ?? (row.delivery === "instant" ? "Instant" : "Escrow Protected"),
    joined: row.joined ?? "",
    priceLow: variants.length > 0 ? Math.min(...variants.map(v => v.price)) : priceDecimal,
    priceHigh: variants.length > 0 ? Math.max(...variants.map(v => v.price)) : priceDecimal,
    seller: {
      name: row.store_name ?? "Unknown",
      rating: Number(row.store_rating ?? 0),
      avatar: row.store_avatar_url || (row.store_avatar ?? "from-slate-600 to-slate-800"),
      // Presence for the card's dot. Same derivation as the store page, so a
      // seller cannot be "online" on one surface and offline on the other.
      online: isOnline(row.store_last_seen ?? null),
      lastSeenAt: row.store_last_seen ?? null,
    },
  };
}

/** Store row → frontend shape (rename *_gradient → bare avatar/banner). */
/** Aggregates the store header shows. All money already decimal USDC. */
export interface StoreStats {
  /** Orders that reached DONE (money actually settled). */
  completedOrders: number;
  /** Mean order value over completed orders, decimal USDC. 0 when none. */
  avgOrderUsdc: number;
  /** Disputes still waiting for a ruling. */
  openDisputes: number;
  /** Mean time from dispute opened → resolved, in minutes. null when none resolved. */
  avgDisputeMinutes: number | null;
  /** Live (non-archived) listings, so the header can show catalogue depth. */
  products: number;
}

export const EMPTY_STORE_STATS: StoreStats = {
  completedOrders: 0,
  avgOrderUsdc: 0,
  openDisputes: 0,
  avgDisputeMinutes: null,
  products: 0,
};

export interface StoreApiRow {
  name: string;
  handle: string | null;
  uid: string | null;
  avatar: string | null;
  banner: string | null;
  rating: number;
  ratingCount: number;
  online: boolean;
  /** ISO timestamp of the seller's last heartbeat, null when never seen. */
  lastSeenAt: string | null;
  joined: string;
  message: string | null;
  stats: StoreStats;
}

export function mapStore(row: {
  name: string;
  handle: string | null;
  uid: string | null;
  avatar_gradient: string | null;
  banner_gradient: string | null;
  avatar_url?: string | null;
  banner_url?: string | null;
  rating: number | string;
  rating_count: number;
  joined_at: string;
  message: string | null;
  last_seen_at?: string | null;
  stats?: Partial<StoreStats> | null;
}): StoreApiRow {
  const lastSeenAt = row.last_seen_at ?? null;
  return {
    name: row.name,
    handle: row.handle,
    uid: row.uid,
    // Prefer real uploaded images; fall back to gradient classes.
    avatar: row.avatar_url || row.avatar_gradient,
    banner: row.banner_url || row.banner_gradient,
    rating: Number(row.rating),
    ratingCount: row.rating_count,
    // Derived, not assumed: a store with no heartbeat in the last two minutes
    // is offline. See lib/presence/window.ts.
    online: isOnline(lastSeenAt),
    lastSeenAt,
    joined: new Date(row.joined_at).toLocaleDateString("en-US", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }),
    message: row.message,
    stats: { ...EMPTY_STORE_STATS, ...(row.stats ?? {}) },
  };
}

/** Review row (joined with buyer avatar) → frontend shape. */
export interface ReviewApiRow {
  user: string;
  avatar: string;
  rating: number;
  date: string;
  text: string;
}

export function mapReview(row: {
  display_name: string | null;
  rating: number;
  text: string | null;
  created_at: string;
  buyer_avatar: string | null;
}): ReviewApiRow {
  return {
    user: row.display_name ?? "Anon",
    avatar: row.buyer_avatar ?? "from-slate-600 to-slate-800",
    rating: row.rating,
    date: new Date(row.created_at).toLocaleDateString("en-US", {
      day: "2-digit",
      month: "short",
    }),
    text: row.text ?? "",
  };
}
