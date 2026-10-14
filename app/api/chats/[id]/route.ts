import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { getThreadMessages } from "@/lib/chat/queries";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;
  const msgs = await getThreadMessages(id, user.id, user.role);
  return jsonOk({ messages: msgs });
}
