/**
 * GET /api/my/transactions
 *
 * Transaction list for the current user with search, filters, pagination and
 * optional CSV export. Sellers see orders placed against their store; everyone
 * else sees orders they bought.
 *
 * Query params:
 *   ?search=...   full text — order id, product name, variant, buyer handle/name
 *   ?status=...   comma-separated: PENDING,PROCESS,SENT,DONE,DISPUTED,CANCELLED
 *   ?dateFrom=2025-08-01&dateTo=2025-08-31
 *   ?minAmount=100&maxAmount=1000000  (micro-USDC)
 *   ?page=1&limit=20&sort=created_at&order=desc
 *   ?format=csv   returns text/csv instead of JSON
 *
 * REWRITTEN. The previous implementation was broken in six ways and is
 * a good example of why raw SQL strings assembled from request input are a trap:
 *
 *   1. `LEFT JOIN wallet_txs wt ON o.on_chain_tx_hash IS NOT NULL` — a join with
 *      NO join key. That is a cartesian product: every order was duplicated once
 *      per `wallet_txs` row, so the list and its totals inflated without bound.
 *   2. It read `wt.blockchain AS payer_wallet_type` — the wrong column from the
 *      wrong table. `orders.payer_wallet_type` is the real column (migration 0050).
 *   3. Search matched `buyer` and `variant_label`, neither of which exists on
 *      `orders` (the columns are `buyer_id` and `variant`). Any search using them
 *      errored the query.
 *   4. The response read `t.variant_label` while the SELECT aliased
 *      `p.variant AS variants`, so `variant` was always undefined.
 *   5. The COUNT query rewrote `$N` placeholders to `?` and shipped the params to
 *      `sql_simple_query`, which cannot substitute either form — so the total was
 *      wrong or the call failed outright.
 *   6. `Math.ceil(count || 0 / limit)` — `/` binds tighter than `||`, so this was
 *      `Math.ceil(count || 0)`: `totalPages` was the row count, not the page count.
 *
 * The rewrite uses the typed Supabase client end to end, so there are no
 * placeholders to substitute and no string-built SQL. Search resolves related
 * rows first and then filters orders by the resulting ids.
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

const SORTABLE_COLUMNS = new Set(["created_at", "amount", "status"]);
const MAX_LIMIT = 100;
const MAX_SEARCH_IDS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OrderRow {
  id: string;
  status: string;
  variant: string | null;
  amount: string | number;
  created_at: string;
  on_chain_tx_hash: string | null;
  payer_wallet_type: string | null;
  product_id: string | null;
  buyer_id: string;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const admin = supabaseAdminClient();
  const url = new URL(request.url);

  const search = (url.searchParams.get("search") || "").trim();
  const statusFilter = (url.searchParams.get("status") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const minAmount = Number.parseInt(url.searchParams.get("minAmount") || "0", 10) || 0;
  const maxAmount =
    Number.parseInt(url.searchParams.get("maxAmount") || "", 10) || Number.MAX_SAFE_INTEGER;
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw
    ? Math.min(Math.max(1, Number.parseInt(limitRaw, 10) || 20), MAX_LIMIT)
    : 20;
  const sortCol = url.searchParams.get("sort") || "created_at";
  const ascending = url.searchParams.get("order") === "asc";
  const format = url.searchParams.get("format") || "json";

  // Allowlist — the value goes straight into `.order()`, so never trust it.
  if (!SORTABLE_COLUMNS.has(sortCol)) {
    return jsonError("invalid sort column", 400);
  }

  // ---- ownership scope -----------------------------------------------------
  let storeId: string | null = null;
  if (user.role === "Seller") {
    const { data: store } = await admin
      .from("stores")
      .select("id")
      .eq("owner_user_id", user.id)
      .maybeSingle();
    storeId = (store?.id as string | undefined) ?? null;
  }

  // ---- search: resolve related rows first, then filter orders by id ---------
  const orClauses: string[] = [];
  if (search) {
    const like = `%${search}%`;

    const [prodRes, userRes] = await Promise.all([
      admin.from("products").select("id").ilike("name", like).limit(MAX_SEARCH_IDS),
      admin
        .from("users")
        .select("id")
        .or(`handle.ilike.${like},name.ilike.${like}`)
        .limit(MAX_SEARCH_IDS),
    ]);

    const productIds = (prodRes.data ?? []).map((p) => p.id as string);
    const buyerIds = (userRes.data ?? []).map((u) => u.id as string);

    if (productIds.length) orClauses.push(`product_id.in.(${productIds.join(",")})`);
    if (buyerIds.length) orClauses.push(`buyer_id.in.(${buyerIds.join(",")})`);
    // A variant match lives on the order itself.
    orClauses.push(`variant.ilike.${like}`);
    // A full UUID in the box means "this exact order".
    if (UUID_RE.test(search)) orClauses.push(`id.eq.${search}`);

    if (orClauses.length === 0) {
      // No related row matched, so nothing can match — return an empty page
      // rather than silently ignoring the search term.
      return emptyResult(format, page, limit);
    }
  }

  // ---- base query ----------------------------------------------------------
  const buildQuery = () => {
    let q = admin
      .from("orders")
      .select(
        "id, status, variant, amount, created_at, on_chain_tx_hash, payer_wallet_type, product_id, buyer_id",
        { count: "exact" },
      );

    if (user.role === "Seller") {
      // A seller with no store yet sees nothing (never another seller's rows).
      q = storeId ? q.eq("store_id", storeId) : q.eq("store_id", "00000000-0000-0000-0000-000000000000");
    } else {
      q = q.eq("buyer_id", user.id);
    }

    if (statusFilter.length) q = q.in("status", statusFilter);
    if (dateFrom) q = q.gte("created_at", dateFrom);
    if (dateTo) q = q.lte("created_at", dateTo);
    if (minAmount > 0) q = q.gte("amount", minAmount);
    if (maxAmount < Number.MAX_SAFE_INTEGER) q = q.lte("amount", maxAmount);
    if (orClauses.length) q = q.or(orClauses.join(","));

    return q;
  };

  const from = (page - 1) * limit;
  const { data, count, error } = await buildQuery()
    .order(sortCol, { ascending })
    .range(from, from + limit - 1);

  if (error) {
    console.error("Transaction query error:", error.message);
    return jsonError("Failed to fetch transactions", 500);
  }

  const orders = (data ?? []) as unknown as OrderRow[];
  const total = count ?? 0;

  // ---- hydrate related rows (one round trip each, no N+1) ------------------
  const productIds = [...new Set(orders.map((o) => o.product_id).filter(Boolean))] as string[];
  const buyerIds = [...new Set(orders.map((o) => o.buyer_id).filter(Boolean))];

  const [prodRes, buyerRes] = await Promise.all([
    productIds.length
      ? admin.from("products").select("id, name").in("id", productIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    buyerIds.length
      ? admin.from("users").select("id, handle, name").in("id", buyerIds)
      : Promise.resolve({ data: [] as { id: string; handle: string | null; name: string | null }[] }),
  ]);

  const productName = new Map(
    ((prodRes.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]),
  );
  const buyerLabel = new Map(
    ((buyerRes.data ?? []) as { id: string; handle: string | null; name: string | null }[]).map(
      (u) => [u.id, u.handle || u.name || ""],
    ),
  );

  const formatted = orders.map((t) => ({
    id: t.id,
    status: t.status,
    product: t.product_id ? (productName.get(t.product_id) ?? null) : null,
    // `orders.variant` is the real column — the old code read a nonexistent
    // `variant_label` off a differently-named alias, so this was always null.
    variant: t.variant,
    buyer: `@${buyerLabel.get(t.buyer_id) || ""}`,
    amount: Number(t.amount) / 1_000_000, // micro-USDC → display
    createdAt: t.created_at,
    onChainTxHash: t.on_chain_tx_hash,
    // Read straight off the order (migration 0050); the old code joined
    // wallet_txs and read `blockchain` from it, which is a different concept.
    payerWalletType: t.payer_wallet_type,
  }));

  if (format === "csv") {
    const headers = [
      "ID", "Date", "Status", "Product", "Variant", "Buyer",
      "Amount (USDC)", "On-chain Tx Hash",
    ];
    const csvRows = formatted.map((t) =>
      [
        t.id.slice(0, 8),
        (t.createdAt || "").slice(0, 19).replace("T", " "),
        t.status,
        csvCell(t.product?.slice(0, 30)),
        csvCell(t.variant?.slice(0, 20)),
        csvCell(t.buyer),
        t.amount.toFixed(2),
        t.onChainTxHash?.slice(0, 16) ?? "",
      ].join(","),
    );

    return new Response(`${headers.join(",")}\n${csvRows.join("\n")}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "inline; filename=transactions.csv",
      },
    });
  }

  return jsonOk({
    transactions: formatted,
    pagination: {
      currentPage: page,
      // Parenthesised: `count || 0 / limit` would divide FIRST (operator
      // precedence), which is the bug that made totalPages equal the row count.
      totalPages: Math.ceil(total / limit),
      totalItems: total,
      itemsPerPage: limit,
    },
  });
}

/** Quote a CSV cell when it contains a comma, quote or newline. */
function csvCell(value: string | null | undefined): string {
  const v = value ?? "";
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Shape-identical empty page (used when a search can match nothing). */
function emptyResult(format: string, page: number, limit: number) {
  if (format === "csv") {
    return new Response(
      "ID,Date,Status,Product,Variant,Buyer,Amount (USDC),On-chain Tx Hash\n",
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "inline; filename=transactions.csv",
        },
      },
    );
  }
  return jsonOk({
    transactions: [],
    pagination: { currentPage: page, totalPages: 0, totalItems: 0, itemsPerPage: limit },
  });
}
