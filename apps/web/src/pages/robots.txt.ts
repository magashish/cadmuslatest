import type { APIRoute } from "astro";
import { publicOrigin } from "../lib/origin";

export const GET: APIRoute = ({ request }) => {
  const origin = publicOrigin(request);

  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
};
