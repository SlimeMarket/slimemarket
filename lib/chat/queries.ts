import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { mapThread, mapMessage, mapForumMessage, type ThreadApiRow, type ForumMessageRow } from "./mappers";
import { toSenderRole } from "@/lib/wl/chat";

const FORUM_CHANNELS = [
  { id: "global", label: "Global", hash: "#global", icon: "globe", gated: false, desc: "Diskusi umum" },
  { id: "wts", label: "WTS", hash: "#wts", icon: "tag", gated: true, desc: "Want To Sell" },
  { id: "wtb", label: "WTB", hash: "#wtb", icon: "search", gated: true, desc: "Want To Buy" },
  { id: "alpha", label: "AlphaShare", hash: "#alpha-share", icon: "gem", gated: true, desc: "Bocoran alpha & WL" },
  { id: "freebie", label: "Freebie", hash: "#freebie", icon: "gift", gated: true, desc: "Gratisan & giveaway" },
  { id: "discount", label: "Discount", hash: "#discount", icon: "badge-percent", gated: true, desc: "Promo & flash sale" },
  { id: "aitalk", label: "AI-Talk", hash: "#ai-talk", icon: "bot", gated: true, desc: "Tools & prompt AI" },
  { id: "nfts", label: "NFTs", hash: "#nfts", icon: "hexagon", gated: true, desc: "Mint, flip, collect" },
];

// ---- Forum channels ----

export function getChannels(userRole?: string | null) {
  // Members only see #global (gated:false). Buyer and above see everything.
  if (!userRole || userRole === "Member") {
    return FORUM_CHANNELS.filter(c => !c.gated);
  }
  return FORUM_CHANNELS;
}

async function resolveForumThread(admin: ReturnType<typeof supabaseAdminClient>, channel: string) {
  const { data: existing } = await admin
    .from("chat_threads")
    .select("id")
    .eq("type", "forum")
    .eq("channel", channel)
    .limit(1);
  if (existing && existing.length > 0) return existing[0].id;

  const { data: created } = await admin
    .from("chat_threads")
    .insert({ type: "forum", status: "active", channel, created_at: new Date().toISOString() })
    .select("id")
    .single();
  if (!created) throw new Error("failed to create forum thread");
  return created.id;
}

export async function getForumMessages(
  channel: string,
  userId?: string | null
): Promise<ForumMessageRow[]> {
  const admin = supabaseAdminClient();
  const threadId = await resolveForumThread(admin, channel);

  const { data, error } = await admin
    .from("chat_messages")
    .select(`
      id, text, created_at, sender_id, sender_role,
      reply_to,
      users!sender_id ( name, avatar_gradient, uid, role )
    `)
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error || !data) return [];

  return (data as unknown[]).map((r: unknown) => {
    const m = r as {
      id: string; text: string; created_at: string;
      sender_id: string | null; sender_role: string;
      reply_to: { user: string; text: string } | null;
      users?: { name?: string; avatar_gradient?: string; uid?: string; role?: string } | null;
    };
    const u = m.users ?? {};
    return {
      ...mapForumMessage({
        id: m.id, user_name: u.name ?? null, user_avatar: u.avatar_gradient ?? null,
        user_uid: u.uid ?? null, user_role: u.role ?? null,
        text: m.text, created_at: m.created_at, reply_to: m.reply_to,
      }, userId ?? ""),
      me: userId ? m.sender_id === userId : false,
    };
  }).reverse(); // oldest-first for chat ordering
}

export async function postForumMessage(
  channel: string, user: { id: string; role: string }, text: string
): Promise<ForumMessageRow> {
  const admin = supabaseAdminClient();
  const threadId = await resolveForumThread(admin, channel);

  const { data, error } = await admin
    .from("chat_messages")
    .insert({
      thread_id: threadId, sender_id: user.id, sender_role: toSenderRole(user.role),
      text, created_at: new Date().toISOString(),
    })
    .select("id, text, created_at, sender_id, sender_role, reply_to")
    .single();
  if (error || !data) throw new Error(`postForumMessage: ${error?.message}`);

  return {
    ...mapForumMessage({
      id: data.id, user_name: "you", user_avatar: null, user_uid: "",
      user_role: user.role, text: data.text, created_at: data.created_at, reply_to: null,
    }, user.id),
    me: true,
  };
}

// ---- Thread access control ----

/**
 * Check if a user has access to a chat thread.
 * - Forum threads: open to all authenticated users.
 * - DM/Dispute threads: user must be in participant_ids, OR be Admin.
 * Returns true if access allowed, false otherwise.
 */
async function checkThreadAccess(
  admin: ReturnType<typeof supabaseAdminClient>,
  threadId: string,
  userId: string,
  /** ACCOUNT role (users.role), e.g. "Admin" | "MM" | "Member". */
  accountRole: string
): Promise<boolean> {
  const { data: thread } = await admin
    .from("chat_threads")
    .select("type, participant_ids")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread) return false;

  // Forum threads are open to all authenticated users
  if (thread.type === "forum") return true;

  // Staff can access all threads (dispute mediation, deal-room monitoring).
  // MM is the middleman role and must be admitted alongside Admin.
  const role = (accountRole || "").toLowerCase();
  if (role === "admin" || role === "mm") return true;

  // DM/Dispute: check participant_ids
  const participants = thread.participant_ids as string[] | null;
  if (!participants || !participants.includes(userId)) return false;

  return true;
}

// ---- DM threads ----

export async function listThreads(userId: string): Promise<ThreadApiRow[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("chat_threads")
    .select(`
      id, type, status, created_at, participant_ids,
      last_text, last_time
    `)
    .contains("participant_ids", [userId])
    .neq("type", "forum")
    .order("last_time", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error || !data) return [];

  // Resolve partner names — for each thread find the other participant
  const threads: ThreadApiRow[] = [];
  for (const row of data) {
    // Find partner (first id != userId)
    const partnerId = (row.participant_ids as string[]).find(pid => pid !== userId) ?? userId;
    const { data: partner } = await supabaseAdminClient()
      .from("users")
      .select("name, avatar_gradient, role, uid")
      .eq("id", partnerId)
      .maybeSingle();

    // Resolve order if attached
    let orderInfo: { id: string; title: string; qty: number; amount: string; status: string; product_id: string } | null = null;
    const orderId = (row as Record<string, unknown>).order_id as string | null | undefined;
    if (orderId) {
      // try orders table, then wl_deals table
      const { data: o } = await supabaseAdminClient()
        .from("orders")
        .select("id, amount, status, qty, products(name), product_id")
        .eq("id", orderId)
        .maybeSingle();
      if (o) {
          orderInfo = {
            id: o.id as string,
            title: ((o.products as { name: string }[] | null)?.[0]?.name) ?? "Order",
            qty: o.qty as number,
            amount: o.amount as string, status: o.status as string, product_id: o.product_id as string,
          };
      }
    }

    threads.push(mapThread({
      id: row.id, type: row.type, status: row.status, created_at: row.created_at,
      participant_ids: row.participant_ids,
      partner_name: partner?.name ?? null, partner_avatar: partner?.avatar_gradient ?? null,
      partner_role: partner?.role ?? null, partner_uid: partner?.uid ?? null,
      order_id: orderInfo?.id ?? null, order_title: orderInfo?.title ?? null,
      order_qty: orderInfo?.qty ?? null, order_amount: orderInfo?.amount ?? null,
      order_status: orderInfo?.status ?? null, order_product_id: orderInfo?.product_id ?? null,
      last_text: row.last_text ?? null, last_time: row.last_time ?? null,
    }, userId));
  }
  return threads;
}

export async function getThreadMessages(
  threadId: string, userId: string, userRole?: string
): Promise<ThreadApiRow["messages"]> {
  const admin = supabaseAdminClient();

  // Resolve user role if not provided
  let role: string = userRole ?? "";
  if (!role) {
    const { data: userData } = await admin.from("users").select("role").eq("id", userId).maybeSingle();
    role = userData?.role ?? "Member";
  }

  // Membership check — reject if user is not a participant (or Admin for dispute threads)
  const hasAccess = await checkThreadAccess(admin, threadId, userId, role);
  if (!hasAccess) return [];

  const { data, error } = await admin
    .from("chat_messages")
    .select("sender_id, sender_role, text, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return (data ?? []).map((r) => mapMessage(r, userId));
}

export async function sendMessage(
  threadId: string, senderId: string, text: string, senderRole: string
) {
  const admin = supabaseAdminClient();

  // Access control needs the ACCOUNT role (users.role), but `senderRole` is
  // the (already mapped) chat role — "buyer"/"middleman". Passing the mapped
  // value straight through meant staff were denied and the pure lowercase
  // "member" value was never consulted. Look the account role up properly.
  const { data: sender } = await admin
    .from("users").select("role").eq("id", senderId).maybeSingle();
  const accountRole = sender?.role ?? "Member";

  // Membership check — prevent sending to threads the user doesn't belong to
  const hasAccess = await checkThreadAccess(admin, threadId, senderId, accountRole);
  if (!hasAccess) throw new Error("not authorized to send messages to this thread");

  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("chat_messages")
    .insert({
      thread_id: threadId, sender_id: senderId,
      // Defensive clamp: any caller that passes a raw account role (e.g.
      // "Member") would otherwise violate chat_messages_sender_role_check.
      sender_role: toSenderRole(senderRole),
      text, created_at: now,
    })
    .select("sender_id, sender_role, text, created_at")
    .single();
  if (error || !data) throw new Error(error?.message);

  // update thread last_text/last_time
  await admin.from("chat_threads").update({ last_text: text, last_time: now }).eq("id", threadId);

  return mapMessage(data, senderId);
}
