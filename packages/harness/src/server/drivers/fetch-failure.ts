/**
 * Undici's TypeError message is "fetch failed" — no URL, no OS/TLS reason.
 * Those live on the call site and `error.cause`. Wrap at `fetch` so
 * ConnectionSpec.error, FAIL, and the omnibox share one line.
 *
 * Wrapping as `Error` (not TypeError): keep `{ cause }` so completion retry
 * still sees the undici TypeError in the chain. A plain `Error` without that
 * cause used to fail the turn instead of backing off.
 */
export type FetchFailureOpts = {
  readonly url: string;
  readonly method?: string;
  readonly why?: string;
};

const GENERIC_FETCH = /^(?:fetch failed|Failed to fetch)$/i;

export function describeFetchLine(opts: FetchFailureOpts, rest: string): string {
  const bits = [opts.why?.trim(), opts.method?.trim().toUpperCase(), opts.url.trim()].filter(
    (bit): bit is string => bit != null && bit !== "",
  );
  const head = bits.join(" ");
  const tail = rest.trim();
  return tail === "" ? head : `${head}: ${tail}`;
}

export function describeHttpFailure(opts: FetchFailureOpts & { status: number; detail?: string }): string {
  const detail = (opts.detail ?? "").trim();
  return describeFetchLine(opts, detail === "" ? `HTTP ${opts.status}` : `HTTP ${opts.status} ${detail}`);
}

export function wrapFetchFailure(error: unknown, opts: FetchFailureOpts): Error {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let node: unknown = error;
  for (let depth = 0; depth < 6 && node != null; depth += 1) {
    if (seen.has(node)) break;
    seen.add(node);
    if (typeof node !== "object") {
      const text = String(node).trim();
      if (text !== "") parts.push(text);
      break;
    }
    const rec = node as { message?: unknown; code?: unknown; cause?: unknown };
    const message = typeof rec.message === "string" ? rec.message.trim() : "";
    const code = typeof rec.code === "string" ? rec.code.trim() : "";
    const generic = message === "" || GENERIC_FETCH.test(message);
    if (generic) {
      if (rec.cause == null) {
        const fallback = message === "" ? code : message;
        if (fallback !== "") parts.push(fallback);
      }
    } else {
      parts.push(message);
    }
    node = rec.cause;
  }
  const text = describeFetchLine(opts, parts.join(": "));
  if (error instanceof Error && error.message === text) return error;
  return new Error(text, { cause: error });
}
