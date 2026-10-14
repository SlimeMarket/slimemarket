import { describe, expect, it } from "vitest";
import { authErrorResponse } from "@/lib/utils";

/**
 * Regression: `requireUser()` / `requireRole()` throw an Error carrying a
 * numeric `.status` (401 unauth, 403 wrong role) rather than returning a
 * response. When those calls sit outside a try/catch, Next.js renders its
 * generic error page and the client sees a **bodyless HTTP 500**.
 *
 * This was found live on 6 routes:
 *   admin/products/[id]/freeze, admin/stores/[id]/freeze,
 *   admin/users/[id]/ban, admin/users/[id]/role,
 *   my/products/[id], my/products/[id]/status  (and sales/stats).
 */
function authErr(status: number): Error & { status: number } {
  const e = new Error(status === 401 ? "UNAUTHORIZED" : "FORBIDDEN") as Error & { status: number };
  e.status = status;
  return e;
}

describe("authErrorResponse", () => {
  it("maps a 401 throw to a 401 JSON response", async () => {
    const res = authErrorResponse(authErr(401));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    await expect(res!.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("maps a 403 throw to a 403 JSON response", async () => {
    const res = authErrorResponse(authErr(403));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    await expect(res!.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("returns null for non-auth errors so callers fall through", () => {
    expect(authErrorResponse(new Error("db exploded"))).toBeNull();
    expect(authErrorResponse(null)).toBeNull();
    expect(authErrorResponse(undefined)).toBeNull();
    expect(authErrorResponse("string")).toBeNull();
    expect(authErrorResponse({ status: 500 })).toBeNull();
    expect(authErrorResponse({ status: 404 })).toBeNull();
  });

  it("never leaks a bare 500 for an auth failure", () => {
    for (const s of [401, 403]) {
      const res = authErrorResponse(authErr(s));
      expect(res!.status).not.toBe(500);
      expect(res!.status).toBe(s);
    }
  });
});
