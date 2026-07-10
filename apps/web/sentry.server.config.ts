import * as Sentry from "@sentry/astro";

Sentry.init({
  dsn: "https://a2397663af60bf987dbf154d2bdc7d70@o4511277288718336.ingest.us.sentry.io/4511278777499648",
  environment: process.env.NODE_ENV ?? "development",
  sendDefaultPii: true,
});
