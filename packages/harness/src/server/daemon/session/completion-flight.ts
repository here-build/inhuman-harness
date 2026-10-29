/**
 * One provider drive per completion round. A second `complete` for the same
 * round joins the running flight, and every caller's abort reaches that one
 * drive until the caller's flight settles.
 */
import type { CompletionExpectation } from "@inhuman.tools/harness-model";
import type { CompleteRequest, CompleteResult } from "@inhuman.tools/harness-provider-sdk";

export class CompletionFlights {
  /** One provider drive per round. A second `complete` joins this promise. */
  readonly #flight = new WeakMap<CompletionExpectation, Promise<CompleteResult>>();
  /**
   * Set before {@link #flight} is stored. The drive writes
   * `orchestrationResult` and flushes reactions while the flight is still unset.
   */
  readonly #claimed = new WeakSet<CompletionExpectation>();
  /** The drive's abort. A later `complete` adopts its signal onto this controller. */
  readonly #abort = new Map<CompletionExpectation, AbortController>();
  /** Drive aborted. The fresh-round reaction must not restamp that as a crash. */
  readonly #aborted = new WeakSet<CompletionExpectation>();

  constructor(private readonly drive: (req: CompleteRequest) => Promise<CompleteResult>) {}

  complete(req: CompleteRequest): Promise<CompleteResult> {
    const flight = this.#flight.get(req.round);
    if (flight !== undefined) return flight.finally(this.#adoptSignal(req.round, req.signal));
    if (this.#claimed.has(req.round)) return this.#join(req);
    this.#claimed.add(req.round);
    const abort = new AbortController();
    this.#abort.set(req.round, abort);
    const release = this.#adoptSignal(req.round, req.signal);
    const pending = this.drive({ ...req, signal: abort.signal });
    this.#flight.set(req.round, pending);
    return pending.finally(() => {
      release();
      if (abort.signal.aborted) this.#aborted.add(req.round);
      this.#abort.delete(req.round);
    });
  }

  aborted(round: CompletionExpectation): boolean {
    return this.#aborted.has(round);
  }

  /** `"park"` pauses the drives: the round stays open for the next wrap. No reason ends them. */
  abortAll(reason?: unknown): void {
    for (const abort of this.#abort.values()) abort.abort(reason);
    this.#abort.clear();
  }

  /** Nested `complete` during the sync prefix, before the flight is stored. */
  #join(req: CompleteRequest): Promise<CompleteResult> {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        const release = this.#adoptSignal(req.round, req.signal);
        const pending = this.#flight.get(req.round);
        if (pending === undefined) {
          release();
          reject(new Error("completion drive missing"));
          return;
        }
        resolve(pending.finally(release));
      });
    });
  }

  /** The caller's abort reaches the drive. The returned release ends that once the caller's flight settles. */
  #adoptSignal(round: CompletionExpectation, signal: AbortSignal | undefined): () => void {
    const abort = this.#abort.get(round);
    if (signal === undefined || abort === undefined || abort.signal.aborted) return () => {};
    if (signal.aborted) {
      abort.abort(signal.reason);
      return () => {};
    }
    const onAbort = () => abort.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }
}
