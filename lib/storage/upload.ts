import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * Product image storage helper.
 *
 * Accepts a base64 data URL (as produced by the frontend ImageUpload), validates
 * type + size, and uploads it to a public Supabase Storage bucket, returning the
 * public URL. The bucket is created lazily (idempotent) so no migration / db
 * reset is required for local dev.
 *
 * If the Storage service is unavailable, it falls back to returning the original
 * data URL (which the browser can still render) so product creation never breaks.
 * Validation errors (bad type / too large) are thrown — the caller decides.
 */

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const bucketEnsured: Record<string, boolean> = {};

async function ensureBucket(bucket: string) {
  if (bucketEnsured[bucket]) return;
  const admin = supabaseAdminClient();
  // createBucket is idempotent-ish: errors with "already exists" if present.
  await admin.storage
    .createBucket(bucket, { public: true, fileSizeLimit: MAX_BYTES })
    .catch(() => {/* already exists or storage offline — ignore */});
  bucketEnsured[bucket] = true;
}

/**
 * Upload a base64 data URL to `bucket/<path>.<ext>` and return its public URL.
 * On storage failure, returns the original data URL (fallback). Throws on
 * invalid/unsupported/oversized input.
 */
export async function uploadImageDataUrl(
  bucket: string,
  path: string,
  dataUrl: string
): Promise<string> {
  const m = /^data:([^;]+);base64,(.+)$/is.exec(dataUrl || "");
  if (!m) throw new Error("invalid image data URL");
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error("unsupported image type (png, jpg, webp, gif only)");
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.byteLength > MAX_BYTES) throw new Error("image too large (max 5MB)");

  try {
    await ensureBucket(bucket);
    const admin = supabaseAdminClient();
    const key = `${path}.${ext}`;
    const { error } = await admin.storage
      .from(bucket)
      .upload(key, buffer, { contentType: mime, upsert: true });
    if (error) throw error;
    const { data } = admin.storage.from(bucket).getPublicUrl(key);
    return data.publicUrl;
  } catch (e) {
    // Storage offline/misconfigured — fall back to inline data URL so the image
    // still renders and product creation doesn't fail.
    console.warn(
      "product image storage upload failed, using inline data URL:",
      e instanceof Error ? e.message : String(e)
    );
    return dataUrl;
  }
}

export const PRODUCT_IMAGE_BUCKET = "product-images";
