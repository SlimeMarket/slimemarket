import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export const dynamic = "force-dynamic";

/**
 * 2 MB — generous for an avatar, and small enough that a hostile upload cannot
 * exhaust memory: the whole file is read into a Buffer and then base64-encoded
 * (~33% larger again), so an uncapped upload is a cheap denial of service.
 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Detect the real image type from the file's MAGIC BYTES.
 *
 * `file.type` is supplied by the client and is trivially spoofed — renaming
 * `payload.html` to `x.png` (or just setting the multipart content type) makes
 * it say `image/png`. The bytes are the only trustworthy signal, so the sniffed
 * value — never the client's claim — is what gets stored.
 */
function sniffImageMime(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * POST /api/me/avatar
 * Upload profile image (avatar) for authenticated user.
 * Accepts multipart/form-data.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  // Reject a wrong content type up-front with 415 instead of letting
  // `req.formData()` throw and surface as a 500. A client sending JSON (or no
  // body at all) is a caller mistake, not a server fault — and the old generic
  // catch leaked the internal `Content-Type was not one of …` message.
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("multipart/form-data")) {
    return jsonError("expected multipart/form-data with an `image` field", 415, {
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("image") as File | null;

    if (!file || !file.type?.startsWith('image/')) {
      return jsonError("valid image required", 400);
    }
    // Cap BEFORE reading the body into memory.
    if (file.size > MAX_AVATAR_BYTES) {
      return jsonError(`image too large (max ${MAX_AVATAR_BYTES / 1024 / 1024} MB)`, 413, {
        code: "PAYLOAD_TOO_LARGE",
      });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // The bytes decide the type — not the client's `file.type`.
    const sniffed = sniffImageMime(buffer);
    if (!sniffed) {
      return jsonError("file is not a valid PNG, JPEG, GIF or WebP image", 415, {
        code: "INVALID_IMAGE_CONTENT",
      });
    }

    const dataUrl = `data:${sniffed};base64,${buffer.toString('base64')}`;

    const admin = supabaseAdminClient();
    
    // Update user's avatar_img
    const { error } = await admin
      .from("users")
      .update({ avatar_url: dataUrl })
      .eq("id", user.id);
    
    if (error) {
      console.error("Avatar update error:", error.message);
      return jsonError("failed to save avatar", 500);
    }

    // Sync avatar to stores table (so product cards/detail show fresh avatar)
    await admin.from("stores")
      .update({ avatar_url: dataUrl, avatar_gradient: null, updated_at: new Date().toISOString() })
      .eq("owner_user_id", user.id);

    // Also update ME object in client-side app
    return jsonOk({ 
      success: true, 
      avatarUrl: dataUrl.slice(0, 100) + "...", // Truncated for response
    });
  } catch (e) {
    // Log the detail server-side; return a GENERIC message. `e.message` can
    // carry internal paths, library internals or SQL fragments, and this
    // response goes straight to the client.
    console.error("Avatar upload error:", e);
    return jsonError("upload failed", 500);
  }
}
