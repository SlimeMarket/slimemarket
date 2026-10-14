/**
 * Telegram sender — env-gated, best-effort, never throws.
 *
 * No-op unless TG_BOT_TOKEN is set. Sends to the provided chatId, else the
 * platform admin channel (TG_ADMIN_CHAT_ID). Configure at deploy time.
 */
export async function sendTelegram(
  text: string,
  chatId?: string
): Promise<{ sent: boolean; reason?: string }> {
  const token = process.env.TG_BOT_TOKEN;
  const chat = chatId ?? process.env.TG_ADMIN_CHAT_ID;
  if (!token || !chat) {
    if (process.env.NODE_ENV !== "production") console.log(`[DEV telegram] ${text.slice(0, 80)}`);
    return { sent: false, reason: "telegram not configured" };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) return { sent: false, reason: `tg http ${r.status}` };
    return { sent: true };
  } catch (e) {
    console.error("sendTelegram failed:", e instanceof Error ? e.message : String(e));
    return { sent: false, reason: "send error" };
  }
}
