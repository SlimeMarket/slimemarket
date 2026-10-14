import { readFile } from "fs/promises";
import path from "path";

/** Catch-all route: serves SPA for ALL paths (clean URLs, no hash). */
export const dynamic = "force-dynamic";
// Phase F6 fix: prevent Next.js from trying to statically generate paths
// for the catch-all (which crashes the Jest worker on Windows). The SPA
// has no static params — every request is served dynamically from index.html.
export const dynamicParams = true;
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET() {
  try {
    const html = await readFile(path.join(process.cwd(), "public", "index.html"), "utf8");
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Prevent browser heuristic caching of the SPA shell. Without this,
        // stale HTML (with stale script versions) gets served after edits.
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch {
    return new Response("<h1>Frontend not found</h1>", { status: 500 });
  }
}
