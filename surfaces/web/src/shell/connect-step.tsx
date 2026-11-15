import { ConnectStepBlock, type ConnectRpcRequest, type ConnectStart } from "@inhuman.tools/harness-ui";

import { parsePark } from "./connect-park.js";

export type Request = ConnectRpcRequest;

/** Returns the active session or kernel RPC request helper for inline connection steps. */
export function connectPort(dial: {
  readonly sessionRpc: { request: Request } | null;
  readonly kernelRpc: { request: Request } | null;
}): Request | null {
  const port = dial.sessionRpc ?? dial.kernelRpc;
  return port ? (method, params) => port.request(method, params) : null;
}

/** Web adapter connecting browser OAuth park parsing into ConnectStepBlock. */
export function ConnectStep({
  start,
  request,
  onDone,
  onCancel,
}: {
  readonly start: ConnectStart;
  readonly request: Request;
  readonly onDone: (connection?: string) => void;
  readonly onCancel: () => void;
}) {
  return <ConnectStepBlock start={start} request={request} parsePark={parsePark} onDone={onDone} onCancel={onCancel} />;
}
