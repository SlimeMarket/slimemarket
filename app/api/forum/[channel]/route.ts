import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { sanitizeText } from "@/lib/sanitize";
import { getForumMessages, postForumMessage, getChannels } from "@/lib/chat/queries";

function channelIsGated(channel: string): boolean {
  const chans = getChannels("Admin"); // full list
  const ch = chans.find(c => c.id === channel);
  return ch?.gated ?? false;
}

export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const user = await getCurrentUser();

  if (channelIsGated(channel)) {
    if (!user || user.role === "Member") {
      return jsonError("this channel requires role Buyer or above", 403);
    }
  }
  try {
    const msgs = await getForumMessages(channel, user?.id ?? null);
    return jsonOk({ messages: msgs });
  } catch (e) { return jsonError(clientErrorMessage(e, "failed"), 500); }
}

export async function POST(req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  if (channelIsGated(channel) && user.role === "Member") {
    return jsonError("this channel requires role Buyer or above", 403);
  }
  let body: unknown; try { body = await req.json(); } catch { body = {}; }
  const text = sanitizeText(((body ?? {}) as { text?: string }).text).trim();
  if (!text) return jsonError("text required", 400);
  try {
    const msg = await postForumMessage(channel, user, text);
    return jsonOk(msg, 201);
  } catch (e) { return jsonError(clientErrorMessage(e, "post failed"), 400); }
}
