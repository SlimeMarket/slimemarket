import type { CurrentUser } from "@/lib/auth-ucw";

/** Chat thread → frontend shape (mirrors CHAT_THREADS in data2.jsx). */
export interface ThreadApiRow {
  id: string;
  user: string;
  avatar: string;
  role: string;
  uid: string;
  type: "normal" | "escrow" | "forum" | "dispute";
  status: "active" | "disrupted" | "closed" | "resolved";
  online: string;
  last: string | null;
  lastTime: string | null;
  order: { id: string; title: string; qty: number; total: number; status: string; productId: string } | null;
  messages: MessageApiRow[];
}

export interface MessageApiRow {
  from: string;    // "me" | "them" | "system" | "seller" | "buyer" | "middleman"
  text: string;
  time: string;
}

export function mapThread(
  row: {
    id: string; type: string; status: string; created_at: string;
    participant_ids: string[];
    partner_name: string | null; partner_avatar: string | null;
    partner_role: string | null; partner_uid: string | null;
    order_id: string | null; order_title: string | null; order_qty: number | null;
    order_amount: string | number | null; order_status: string | null;
    order_product_id: string | null;
    last_text: string | null; last_time: string | null;
  },
  userId: string
): ThreadApiRow {
  return {
    id: row.id,
    user: row.partner_name ?? "Unknown",
    avatar: row.partner_avatar ?? "from-slate-600 to-slate-800",
    role: row.partner_role ?? "Member",
    uid: row.partner_uid ?? "",
    type: (["normal", "escrow", "forum", "dispute"].includes(row.type) ? row.type : "normal") as "normal" | "escrow" | "forum" | "dispute",
    status: (row.status as "active" | "disrupted" | "closed" | "resolved") || "active",
    online: "Active",
    last: row.last_text,
    lastTime: row.last_time
      ? new Date(row.last_time).toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })
      : null,
    order: row.order_id ? {
      id: row.order_id,
      title: row.order_title ?? "",
      qty: row.order_qty ?? 1,
      total: row.order_amount ? Number(BigInt(row.order_amount) / 1_000_000n) : 0,
      status: row.order_status ?? "",
      productId: row.order_product_id ?? "",
    } : null,
    messages: [], // populated separately by listMessages
  };
}

export function mapMessage(row: {
  sender_id: string | null; sender_role: string; text: string; created_at: string;
}, userId: string): MessageApiRow {
  let from = "them";
  if (row.sender_role === "system") from = "system";
  else if (row.sender_role === "middleman") from = "middleman";
  else if (row.sender_role === "admin") from = "admin";
  else if (row.sender_id === userId) from = "me";
  else if (row.sender_role === "seller") from = "seller";
  else if (row.sender_role === "buyer") from = "buyer";
  return {
    from,
    text: row.text,
    time: new Date(row.created_at).toLocaleString("en-US", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    }),
  };
}

export interface ForumChannelRow {
  id: string; label: string; hash: string; icon: string; gated: boolean; desc: string;
}

export interface ForumMessageRow {
  id: string;
  user: string; avatar: string; uid: string; role: string;
  text: string; time: string;
  me: boolean;
  replyTo?: { user: string; text: string } | null;
}

export function mapForumMessage(row: {
  id: string; user_name: string | null; user_avatar: string | null;
  user_uid: string | null; user_role: string | null;
  text: string; created_at: string;
  reply_to: { user: string; text: string } | null;
}, userId: string): ForumMessageRow {
  return {
    id: row.id,
    user: row.user_name ?? "Anon",
    avatar: row.user_avatar ?? "from-slate-600 to-slate-800",
    uid: row.user_uid ?? "",
    role: row.user_role ?? "Member",
    text: row.text,
    time: new Date(row.created_at).toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
    me: false, // set by caller based on current user
    replyTo: row.reply_to ?? null,
  };
}
