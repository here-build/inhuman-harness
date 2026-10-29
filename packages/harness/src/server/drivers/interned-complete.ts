/**
 * Session/research port: intern the row, then `connection.complete`.
 * `KernelDaemon` has no `complete()`.
 */
import {
  connectionSupports,
  type CapabilityConnection,
  type CompleteRequest,
  type CompleteResult,
} from "@inhuman.tools/harness-provider-sdk";
import { ConnectionMiss } from "@inhuman.tools/plexus-expectations/driver";
import type { Orchestrator } from "@inhuman.tools/plexus-expectations/executor";
import invariant from "tiny-invariant";

export async function internedComplete(orch: Orchestrator, req: CompleteRequest): Promise<CompleteResult> {
  if (!Object.hasOwn(orch.connections, req.connectionId)) {
    throw new ConnectionMiss("noconnect", `unknown connection ${req.connectionId}`);
  }
  invariant(req.round.plexus != null, "complete: round must be homed");
  const instance = (await orch.ensure(req.connectionId)) as CapabilityConnection;
  if (!connectionSupports(instance, "completion") || instance.complete == null) {
    throw new ConnectionMiss("noconnect", `connection ${req.connectionId} cannot complete`);
  }
  return instance.complete(req);
}
