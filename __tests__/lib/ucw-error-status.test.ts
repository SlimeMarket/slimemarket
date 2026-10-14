import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { circleErrorExtra, circleErrorStatus } from "@/lib/ucw/error-status";

/**
 * An expired Circle session used to surface as HTTP 500:
 *
 *     500 {"error":"The userToken is invalid."}
 *
 * which is wrong twice over — it looks like a server bug, and it leaves the UI
 * no way to tell the user to log in again. 401 is the honest answer: the client
 * must re-authenticate and retrying will never help.
 */

describe("circleErrorStatus", () => {
  it("treats an invalid/expired Circle session as 401, not 500", () => {
    // The exact string Circle returns, observed live.
    expect(circleErrorStatus("The userToken is invalid.")).toBe(401);
    expect(circleErrorStatus("invalid token")).toBe(401);
    expect(circleErrorStatus("Unauthorized")).toBe(401);
    expect(circleErrorStatus("Circle API returned 401")).toBe(401);
  });

  it("treats missing server configuration as 503", () => {
    expect(circleErrorStatus("CIRCLE_API_KEY not configured")).toBe(503);
    expect(circleErrorStatus("userToken is required")).toBe(503);
  });

  it("leaves anything else as 500", () => {
    expect(circleErrorStatus("socket hang up")).toBe(500);
    expect(circleErrorStatus("")).toBe(500);
  });

  it("attaches a machine-readable code only for 401", () => {
    expect(circleErrorExtra(401)).toEqual({ code: "UCW_SESSION_INVALID" });
    expect(circleErrorExtra(500)).toBeUndefined();
    expect(circleErrorExtra(503)).toBeUndefined();
  });

  it("the checkout challenge route actually uses the helper", () => {
    // Guard against the mapping being inlined again and drifting from this test.
    const src = readFileSync(
      join(__dirname, "..", "..", "app", "api", "orders", "checkout", "challenge", "route.ts"),
      "utf8",
    );
    expect(src).toContain("circleErrorStatus(msg)");
    expect(src).toContain("circleErrorExtra(status)");
  });
});
