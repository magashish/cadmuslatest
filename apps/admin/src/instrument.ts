import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "https://1cbd3106b064074f43f0ba15da0cc7e7@o4511277288718336.ingest.us.sentry.io/4511278803386368",
  environment: String(import.meta.env.MODE),
  sendDefaultPii: true,
});
