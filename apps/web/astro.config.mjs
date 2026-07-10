import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import sentry from "@sentry/astro";
import tailwindPlugin from "@tailwindcss/vite";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  site: process.env.PUBLIC_SITE_URL || undefined,
  integrations: [
    sentry({
      sourceMapsUploadOptions: {
        enabled: Boolean(process.env.SENTRY_AUTH_TOKEN),
        org: "frobro-web-technologies",
        project: "cadmus-web",
        authToken: process.env.SENTRY_AUTH_TOKEN,
      },
    }),
  ],
  vite: {
    plugins: [tailwindPlugin()],
    ssr: {
      noExternal: ["@cadmus/shared"],
    },
  },
});
