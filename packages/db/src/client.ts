import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

let connectionString = process.env.DATABASE_URL ?? "postgresql://cadmus:cadmus@localhost:5432/cadmus";

// When using Cloud SQL unix socket, strip any ?host= param from the URL
// to avoid sending it as a Postgres runtime parameter (which causes
// "unrecognized configuration parameter" errors). The socket path is
// set via the `host` connection option instead.
if (process.env.CLOUD_SQL_CONNECTION) {
  const url = new URL(connectionString);
  url.searchParams.delete("host");
  connectionString = url.toString();
}

// Keep the per-instance pool small: on Cloud Run every running instance opens
// its OWN pool, and dev + prod + the scanner job all share one Cloud SQL server.
// Total peak connections ≈ (sum of each service's max-instances) × max. Sizing
// `max` too high exhausts Cloud SQL's connection slots when instances scale out.
const client = postgres(connectionString, {
  max: 4,
  idle_timeout: 20,
  connect_timeout: 10,
  ...(process.env.CLOUD_SQL_CONNECTION
    ? { host: `/cloudsql/${process.env.CLOUD_SQL_CONNECTION}` }
    : {}),
});
export const db = drizzle(client, { schema });
