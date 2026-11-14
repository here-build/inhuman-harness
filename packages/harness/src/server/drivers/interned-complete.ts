/**
 * Session/research port: intern the row, then `connection.complete`.
 * `KernelDaemon` has no `complete()`.
 */
import { ConnectionMiss } from "@inhuman.tools/expectations/driver";
import type { Orchestrator } from "@inhuman.tools/expectations/executor";
import {
  connectionSupports,
  type CapabilityConnection,
  type CompleteRequest,
  type CompleteResult,
} from "@inhuman.tools/harness-provider-sdk";
import invariant from "tiny-invariant";

export async function internedComplete(orch: Orchestrator, req: CompleteRequest): Promise<CompleteResult> {
  if (!Object.hasOwn(orch.connections, req.connectionId)) {
    throw new ConnectionMiss("noconnect", `unknown connection ${req.connectionId}`);
  }
  invariant(req.round.document != null, "complete: round must be homed");
  const instance = (await orch.ensure(req.connectionId)) as CapabilityConnection;
  if (!connectionSupports(instance, "completion") || instance.complete == null) {
    throw new ConnectionMiss("noconnect", `connection ${req.connectionId} cannot complete`);
  }
  return instance.complete(req);
}
