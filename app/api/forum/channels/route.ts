import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonOk } from "@/lib/utils";
import { getChannels } from "@/lib/chat/queries";

export async function GET() {
  const user = await getCurrentUser();
  const channels = getChannels(user?.role ?? null);
  return jsonOk({ channels });
}
