import crypto from "crypto";
import type { NextRequest } from "next/server";

/**
 * Shared Circle webhook verification primitives.
 *
 * Circle signs EVERY webhook (wallet notifications AND smart-contract event
 * logs) the same way: an RSA-SHA256 signature over the raw request body, sent in
 * `x-circle-signature`, with the key id in `x-circle-key-id`. The public key is
 * fetched from Circle by key id and cached in-process.
 *
 * Extracted from `app/api/webhooks/circle/route.ts` so the escrow event webhook
 * (`app/api/webhooks/escrow/route.ts`) can reuse it instead of copy-pasting.
 * Duplicated crypto is how signature checks silently drift apart.
 */

const PUBLIC_KEY_TTL_MS = 6 * 60 * 60 * 1000; // 6h — keys rotate rarely
const publicKeyCache = new Map<string, { pem: string; fetchedAt: number }>();

/** sha256 of the raw body — used as the `webhook_events.dedupe_hash` unique key. */
export function generateDedupeHash(bodyString: string): string {
  return crypto.createHash("sha256").update(bodyString).digest("hex");
}

/** Fetches (and caches) Circle's webhook public key for the given key id. */
export async function getCirclePublicKey(keyId: string): Promise<string> {
  const cached = publicKeyCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < PUBLIC_KEY_TTL_MS) {
    return cached.pem;
  }

  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("CIRCLE_API_KEY is not set");

  const response = await fetch(
    `https://api.circle.com/v2/notifications/publicKey/${keyId}`,
    {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch public key: ${response.statusText}`);
  }
  const data = await response.json();
  const rawPublicKey = data?.data?.publicKey;
  if (typeof rawPublicKey !== "string") {
    throw new Error("Invalid public key format");
  }
  const pem = [
    "-----BEGIN PUBLIC KEY-----",
    ...(rawPublicKey.match(/.{1,64}/g) ?? []),
    "-----END PUBLIC KEY-----",
  ].join("\n");

  publicKeyCache.set(keyId, { pem, fetchedAt: Date.now() });
  return pem;
}

/** Verifies `x-circle-signature` over the raw body. Never throws — returns false. */
export async function verifyCircleSignature(
  bodyString: string,
  signature: string,
  keyId: string
): Promise<boolean> {
  try {
    const publicKey = await getCirclePublicKey(keyId);
    const verifier = crypto.createVerify("SHA256");
    verifier.update(bodyString);
    verifier.end();
    const signatureUint8Array = Uint8Array.from(Buffer.from(signature, "base64"));
    return verifier.verify(publicKey, signatureUint8Array);
  } catch (e) {
    console.error("Circle webhook: signature verification failure:", e);
    return false;
  }
}

/**
 * Optional IP allowlist. Only enforced when `envVar` is set to a comma-separated
 * list, so local dev and preview deploys keep working.
 */
export function isIpAllowed(req: NextRequest, envVar: string): boolean {
  const allowed =
    process.env[envVar]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (allowed.length === 0) return true;
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return !!clientIp && allowed.includes(clientIp);
}

