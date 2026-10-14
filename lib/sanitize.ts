/**
 * XSS Sanitization helper — server-side (Next.js API routes)
 *
 * React JSX auto-escapes all interpolated strings on the client. This adds
 * defense-in-depth for user-generated content at the API boundary.
 *
 * Usage in API routes:
 *   import { sanitizeText } from "@/lib/sanitize";
 *   const safe = sanitizeText(req.body.description);
 */
import sanitizeHtml from "sanitize-html";

/**
 * Sanitize user text — strips ALL HTML tags, keeps only plain text.
 * Safe for: product descriptions, forum posts, chat messages, notes, memos.
 */
export function sanitizeText(input: unknown): string {
  if (typeof input !== "string") return "";
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
}

/**
 * Sanitize rich text — allows lightweight formatting (<b>, <i>, <br>, <a>) but
 * strips scripts, event handlers, iframe, etc.
 * Use only if you intentionally want formatted text.
 */
export function sanitizeRichText(input: unknown): string {
  if (typeof input !== "string") return "";
  return sanitizeHtml(input, {
    allowedTags: ["b", "i", "em", "strong", "br", "p", "a"],
    allowedAttributes: { a: ["href", "target", "rel"] },
  }).trim();
}

/** Validate + normalize an EVM wallet address (0x + 40 hex chars). */
export function sanitizeEvmAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}
