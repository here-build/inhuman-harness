/**
 * Keyless free-tier ring: Exa → Parallel → Firecrawl → Keenable → Tavily.
 * Round-robin start; throttling and transient failures hop within a shared time budget.
 */
import {
  extractVendor,
  KEYLESS_RING,
  KEYLESS_SESSION_ID,
  SEARCH_TIMEOUT_MS,
  searchVendor,
  type ExtractOutcome,
  type ExtractRequest,
  type KeylessVendor,
  type SearchOutcome,
  type SearchRequest,
} from "../wire/index.js";

export const FAILOVER_TIMEOUT_MS = SEARCH_TIMEOUT_MS;

let ringCursor = Number.parseInt(KEYLESS_SESSION_ID.slice(0, 8), 16) % KEYLESS_RING.length;

function nextStart(): number {
  const start = ringCursor;
  ringCursor = (ringCursor + 1) % KEYLESS_RING.length;
  return start;
}

export function ringOrder(start = nextStart()): readonly KeylessVendor[] {
  return [...KEYLESS_RING.slice(start), ...KEYLESS_RING.slice(0, start)];
}

type Failure = {
  readonly ok: false;
  readonly error: string;
  readonly throttled: boolean;
  readonly retryable?: boolean;
};

async function walk<T extends { readonly ok: true } | Failure>(
  signal: AbortSignal,
  start: number | undefined,
  attempt: (vendor: KeylessVendor, signal: AbortSignal) => Promise<T>,
): Promise<T | (Failure & { vendor: "keyless" })> {
  const deadline = AbortSignal.timeout(FAILOVER_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, deadline]);
  // Read through a function: abort state can change across an awaited attempt.
  const expired = (): boolean => deadline.aborted;
  const failures: string[] = [];
  let allThrottled = true;
  for (const vendor of ringOrder(start)) {
    signal.throwIfAborted();
    if (expired()) break;
    let result: T;
    try {
      result = await attempt(vendor, combined);
    } catch (error) {
      signal.throwIfAborted();
      if (!expired()) throw error;
      break;
    }
    signal.throwIfAborted();
    if (expired()) break;
    if (result.ok || (!result.throttled && !result.retryable)) return result;
    failures.push(`${vendor}: ${result.error}`);
    allThrottled &&= result.throttled;
  }
  return {
    ok: false,
    error: `${deadline.aborted ? "keyless failover time budget exhausted" : "all keyless vendors failed"}: ${failures.join("; ")}`,
    throttled: !deadline.aborted && allThrottled,
    retryable: true,
    vendor: "keyless",
  };
}

export async function searchWithFailover(
  req: Omit<SearchRequest, "apiKey" | "apiUrl">,
  start?: number,
): Promise<SearchOutcome> {
  return walk(req.signal, start, (vendor, signal) => searchVendor(vendor, { ...req, signal }));
}

export async function extractWithFailover(
  req: Omit<ExtractRequest, "apiKey" | "apiUrl">,
  start?: number,
): Promise<ExtractOutcome> {
  return walk(req.signal, start, (vendor, signal) => extractVendor(vendor, { ...req, signal }));
}
