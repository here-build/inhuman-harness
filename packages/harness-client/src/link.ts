import {
  encodeJsonRpcRequest,
  isUiForm,
  jsonRpcResponse,
  methodForPath,
  type UiAnswer,
  type UiForm,
} from "@inhuman.tools/harness-contract";
import type { ClientLink, ClientOptions } from "@orpc/client";

import { HarnessClosedError, HarnessParkError, HarnessRpcError } from "./errors.js";
import type { Transport } from "./transport.js";

/**
 * Answers a parked UI form. Returning resumes the parked call with the answer
 * (`ui/resolve`); throwing cancels the park and rejects the original call.
 */
export type ParkHandler = (form: UiForm) => UiAnswer | Promise<UiAnswer>;

interface Waiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * oRPC `ClientLink` that speaks the daemon's JSON-RPC wire. A procedure's tree
 * path is mapped to its wire name through the contract (`meta.method`).
 */
export class JsonRpcLink implements ClientLink<Record<never, never>> {
  readonly #transport: Transport;
  readonly #onPark: ParkHandler | undefined;
  readonly #waiters = new Map<number, Waiter>();
  #nextId = 1;
  #closed: HarnessClosedError | undefined;

  constructor(transport: Transport, onPark?: ParkHandler) {
    this.#transport = transport;
    this.#onPark = onPark;
    transport.onMessage((text) => this.#deliver(text));
    transport.onClose((cause) => this.#fail(new HarnessClosedError("connection closed", { cause })));
  }

  async call(path: readonly string[], input: unknown, options: ClientOptions<Record<never, never>>): Promise<unknown> {
    const method = methodForPath(path);
    if (method === undefined) throw new Error(`not a procedure of the harness contract: ${path.join(".")}`);
    let result = await this.#request(method, input ?? {}, options.signal);
    while (isUiForm(result)) {
      const form = result;
      if (this.#onPark === undefined) throw new HarnessParkError(form);
      let answer: UiAnswer;
      try {
        answer = await this.#onPark(form);
      } catch (error) {
        // Free the parked call on the daemon rather than leave it until the socket closes.
        await this.#request("ui/resolve", { pending: form.pending, kind: "cancel" }, options.signal).catch(
          () => undefined,
        );
        throw error;
      }
      result = await this.#request("ui/resolve", { pending: form.pending, ...answer }, options.signal);
    }
    return result;
  }

  #request(method: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.#waiters.delete(id);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      try {
        this.#transport.send(encodeJsonRpcRequest(id, method, params));
      } catch (error) {
        this.#waiters.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      }
    });
  }

  #deliver(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = jsonRpcResponse.safeParse(raw);
    if (!parsed.success || typeof parsed.data.id !== "number") return;
    const waiter = this.#waiters.get(parsed.data.id);
    if (waiter === undefined) return;
    this.#waiters.delete(parsed.data.id);
    if ("error" in parsed.data) {
      const { code, message, data } = parsed.data.error;
      waiter.reject(new HarnessRpcError(code, message, data));
    } else {
      waiter.resolve(parsed.data.result);
    }
  }

  #fail(error: HarnessClosedError): void {
    this.#closed ??= error;
    const waiters = [...this.#waiters.values()];
    this.#waiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}
