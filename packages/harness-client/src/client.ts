import type { HarnessContract, UiForm } from "@inhuman.tools/harness-contract";
import { createORPCClient, type Client } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";

import { JsonRpcLink, type ParkHandler } from "./link.js";
import type { Transport } from "./transport.js";

/**
 * The typed client. A parking method's declared output is `result | UiForm`;
 * the client either resolves the park (`onPark`) or rejects with
 * `HarnessParkError`, so a call never returns the form and the type drops it.
 */
type WithoutPark<R> =
  R extends Client<infer C, infer I, infer O, infer E>
    ? Client<C, I, Exclude<O, UiForm>, E>
    : { [K in keyof R]: WithoutPark<R[K]> };

export type HarnessClient = WithoutPark<ContractRouterClient<HarnessContract>>;

export interface HarnessClientOptions {
  readonly transport: Transport;
  /**
   * Called when a method parks for UI. Return the answer to resume the call
   * (its result is what the original call resolves with). Without it a park
   * rejects the call with `HarnessParkError`.
   */
  readonly onPark?: ParkHandler;
}

/**
 * Typed client over one connection. The connection decides the host: a session
 * socket also reaches kernel methods (the daemon falls through), a kernel socket
 * does not reach session methods. Close the transport to dispose the client.
 *
 * Inputs and outputs are not re-validated here; the daemon validates both.
 */
export function createHarnessClient(options: HarnessClientOptions): HarnessClient {
  const link = new JsonRpcLink(options.transport, options.onPark);
  return createORPCClient(link) as HarnessClient;
}
