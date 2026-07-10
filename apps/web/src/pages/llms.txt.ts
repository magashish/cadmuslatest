import type { APIRoute } from "astro";
import { API_BASE } from "../lib/api";

// Serves /llms.txt at the site root by proxying the API, which generates the
// document (or serves a stored override) and gates it to non-free sites — a
// free-tier site returns 404 here too, matching its noindex status.
export const GET: APIRoute = async ({ locals }) => {
  const siteId = locals.siteId;
  if (!siteId) {
    return new Response("Not found", { status: 404 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/api/public/llms.txt`, {
      headers: { "x-site-id": siteId },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  if (!upstream.ok) {
    return new Response("Not found", { status: upstream.status === 404 ? 404 : 502 });
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=900, s-maxage=900",
    },
  });
};
