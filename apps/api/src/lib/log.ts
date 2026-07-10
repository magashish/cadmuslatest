// Cloud Run's log agent splits multi-line stdout/stderr writes into one log
// entry PER LINE, which shreds util.inspect error dumps into meaningless
// fragments in the log viewer. Emit a single line of structured JSON instead:
// Cloud Logging parses it (severity and message become first-class fields) and
// the stack survives intact as an escaped string inside the payload.
export function logError(context: string, err: unknown): void {
  const e = err instanceof Error ? err : null;
  console.error(
    JSON.stringify({
      severity: "ERROR",
      message: `${context}: ${e ? e.message : String(err)}`,
      ...(e?.stack ? { stack: e.stack } : {}),
    })
  );
}
