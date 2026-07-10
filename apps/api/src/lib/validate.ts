import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";

/**
 * Read a request's JSON body and validate it against a zod schema. Throws a 400
 * HTTPException (rendered by the global onError handler) with a readable message
 * on malformed JSON or schema-validation failure, so route handlers receive a
 * fully-typed, validated object instead of an `as`-cast of untrusted input.
 */
export async function readValidatedJson<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON in request body" });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".");
    const message = issue
      ? `${path ? `${path}: ` : ""}${issue.message}`
      : "Invalid request body";
    throw new HTTPException(400, { message });
  }
  return result.data;
}
