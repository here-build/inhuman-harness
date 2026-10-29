import {
  encodeJsonRpcError,
  encodeJsonRpcResult,
  jsonRpcRequest,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcId,
} from "@/protocol/rpc";
import type { PlaneSocket } from "@/yjs";

import { parseJsonUnknown, readField } from "../util/read-field.js";

/**
 * JSON-RPC request id plus the live connection that received the envelope.
 * Client ids are not unique across connections; replies stay on this connection.
 */
export type RpcRequestIdentity = {
  readonly requestId: JsonRpcId | undefined;
  readonly connectionId: string;
};

/** Application dispatch/validation/UI park. Transport does not construct a domain host. */
export type RpcApplication = {
  handleRequest(method: string, args: unknown, identity: RpcRequestIdentity): Promise<unknown>;
  onPlaneClose?(connectionId: string): void;
};

export async function serveJsonRpc(
  socket: PlaneSocket,
  application: RpcApplication,
  text: string,
  connectionId: string,
): Promise<void> {
  let raw: unknown;
  try {
    raw = parseJsonUnknown(text);
  } catch {
    socket.sendText(encodeJsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"));
    return;
  }

  const parsed = jsonRpcRequest.safeParse(raw);
  if (!parsed.success) {
    socket.sendText(encodeJsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"));
    return;
  }

  const { method, params, id } = parsed.data;
  const identity: RpcRequestIdentity = { requestId: id, connectionId };
  try {
    const result = await application.handleRequest(method, params, identity);
    if (identity.requestId === undefined) return;
    socket.sendText(encodeJsonRpcResult(identity.requestId, result));
  } catch (error) {
    if (identity.requestId === undefined) return;
    const code =
      typeof error === "object" && error !== null ? Number(readField(error, "code")) : JSON_RPC_INTERNAL_ERROR;
    const message = error instanceof Error ? error.message : "Internal error";
    socket.sendText(
      encodeJsonRpcError(identity.requestId, Number.isInteger(code) ? code : JSON_RPC_INTERNAL_ERROR, message),
    );
  }
}
