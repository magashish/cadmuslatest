import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
  return new Response(
    JSON.stringify({
      app: "web",
      env: process.env.APP_ENV ?? null,
      gitSha: process.env.GIT_SHA ?? null,
      gitTag: process.env.GIT_TAG ?? null,
      builtAt: process.env.BUILT_AT ?? null,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
};
