import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * BUG 15 — POST /api/me/avatar answered 500 on a wrong Content-Type.
 *
 * The endpoint called `req.formData()` inside a try/catch whose catch returned
 * `jsonError(msg, 500)`. When a client posted JSON (or nothing at all),
 * `formData()` threw `Content-Type was not one of "multipart/form-data..."`,
 * so:
 *   1. the status was 500 — a server error for a plain caller mistake, which
 *      makes it look like the route is broken in a sweep, and
 *   2. the internal parser message was echoed back to the client.
 *
 * Live proof (before the fix), Member session:
 *   POST /api/me/avatar  Content-Type: application/json  -> 500
 *     {"error":"Content-Type was not one of \"multipart/form-data\\ ..."}
 * After the fix both a JSON body and a bodyless POST return:
 *   415 {"error":"expected multipart/form-data with an `image` field",
 *        "code":"UNSUPPORTED_MEDIA_TYPE"}
 *
 * This was surfaced by endpoint-audit.mjs, which flagged it as the only 5xx
 * across 183 method probes.
 */
const SRC = fs
  .readFileSync(path.join(process.cwd(), "app/api/me/avatar/route.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("POST /api/me/avatar — rejects a non-multipart body with 415", () => {
  it("checks the Content-Type before calling formData()", () => {
    const guard = SRC.indexOf("multipart/form-data");
    const parse = SRC.indexOf("req.formData()");
    expect(guard, "no multipart/form-data guard found").toBeGreaterThan(-1);
    expect(parse, "no req.formData() call found").toBeGreaterThan(-1);
    // The guard must run BEFORE the parser, otherwise the parser throws first.
    expect(guard, "guard must precede req.formData()").toBeLessThan(parse);
  });

  it("returns 415 (not 500) for the wrong content type", () => {
    // Multi-line call: jsonError(\n  "...", \n  415,\n  { code: ... }\n)
    // so match the status argument on its own rather than across parens.
    expect(SRC).toMatch(/415\s*,/);
    expect(SRC).not.toMatch(/jsonError\([^)]*Content-Type was not one/i);
  });

  it("tags the response with a machine-readable code", () => {
    expect(SRC).toMatch(/UNSUPPORTED_MEDIA_TYPE/);
  });

  it("does not let the generic catch downgrade a caller mistake to 500", () => {
    // The old code leaked `e.message` with a 500 status. Whatever the catch
    // does now, the multipart guard must short-circuit before it.
    const guardIdx = SRC.indexOf("UNSUPPORTED_MEDIA_TYPE");
    const catchIdx = SRC.indexOf("catch (e)");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(catchIdx);
  });

  it("still accepts multipart and validates the image field", () => {
    // The happy path must be intact: an `image` field whose type is image/*.
    expect(SRC).toMatch(/formData\.get\(["']image["']\)/);
    expect(SRC).toMatch(/startsWith\(["']image\//);
  });
});

/**
 * Upload hardening (2026-10-06). The route used to:
 *   - read the ENTIRE file into a Buffer with no size cap → a large upload is a
 *     cheap memory-exhaustion DoS (the body is then base64-encoded, ~33% more),
 *   - trust `file.type` for the stored data URL, and that value is supplied by
 *     the CLIENT — rename `payload.html` to `x.png` and it says `image/png`,
 *   - echo `e.message` back on failure, leaking internal detail.
 */
describe("POST /api/me/avatar — upload hardening", () => {
  it("caps the size BEFORE buffering the whole body", () => {
    expect(SRC, "no size cap constant").toMatch(/MAX_AVATAR_BYTES/);
    const sizeCheck = SRC.indexOf("file.size >");
    const buffer = SRC.indexOf("file.arrayBuffer()");
    expect(sizeCheck, "no `file.size >` guard").toBeGreaterThan(-1);
    expect(buffer, "no arrayBuffer() call").toBeGreaterThan(-1);
    // Reading first and checking after would already have the bytes in memory.
    expect(sizeCheck, "size check must precede arrayBuffer()").toBeLessThan(buffer);
    expect(SRC, "oversized upload must be 413").toMatch(/413\s*,/);
  });

  it("sniffs the real type from magic bytes and stores THAT, not file.type", () => {
    expect(SRC, "no magic-byte sniffer").toMatch(/sniffImageMime/);
    expect(SRC, "stored data URL must use the sniffed type").toMatch(/data:\$\{sniffed\}/);
    expect(SRC, "must not trust the client-supplied file.type").not.toMatch(/data:\$\{file\.type\}/);
    expect(SRC, "rejected content must be 415").toMatch(/INVALID_IMAGE_CONTENT/);
  });

  it("does not echo the internal error message to the client", () => {
    expect(SRC).not.toMatch(/jsonError\(e instanceof Error \? e\.message/);
    expect(SRC, "generic 500 message expected").toMatch(/jsonError\(["']upload failed["'],\s*500\)/);
  });
});
