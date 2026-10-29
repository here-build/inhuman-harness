import { type JsonRpcId } from "./schemas/rpc.js";

export const JSON_RPC_VERSION = "2.0" as const;
export const JSON_RPC_PARSE_ERROR = -32_700;
export const JSON_RPC_INVALID_REQUEST = -32_600;
export const JSON_RPC_METHOD_NOT_FOUND = -32_601;
export const JSON_RPC_INVALID_PARAMS = -32_602;
export const JSON_RPC_INTERNAL_ERROR = -32_603;

/** JSON-RPC error on a Client waiter. Transport loss is a plain Error. */
export class RpcClientError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
  }
}

/** Method-not-found / invalid-params: do not treat as a socket drop. */
export function isRpcContractError(error: unknown): boolean {
  return (
    error instanceof RpcClientError &&
    (error.code === JSON_RPC_METHOD_NOT_FOUND || error.code === JSON_RPC_INVALID_PARAMS)
  );
}

export function encodeJsonRpcRequest(id: string | number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params });
}

export function encodeJsonRpcResult(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, result });
}

export function encodeJsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  return JSON.stringify({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}
