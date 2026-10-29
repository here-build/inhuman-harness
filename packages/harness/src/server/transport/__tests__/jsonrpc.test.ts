import { describe, expect, it } from "vitest";

import {
  encodeJsonRpcError,
  encodeJsonRpcRequest,
  encodeJsonRpcResult,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
} from "@/protocol/rpc";
import type { PlaneSocket } from "@/yjs";

import { RpcMethodNotFound } from "../../contract.js";
import { serveJsonRpc, type RpcApplication, type RpcRequestIdentity } from "../jsonrpc.js";

function fakePlane(): {
  socket: PlaneSocket;
  texts: string[];
} {
  const texts: string[] = [];
  const socket: PlaneSocket = {
    send: () => undefined,
    sendText: (text) => {
      texts.push(text);
    },
    close: () => undefined,
    onBinary: () => undefined,
    onText: () => undefined,
    onClose: () => undefined,
  };
  return { socket, texts };
}

describe("JSON-RPC transport delivery", () => {
  it("delivers an envelope to an application stub without KernelDaemon", async () => {
    const seen: Array<{
      method: string;
      args: unknown;
      identity: RpcRequestIdentity;
    }> = [];
    const application: RpcApplication = {
      async handleRequest(method, args, identity) {
        seen.push({ method, args, identity });
        return { pong: true };
      },
    };
    const plane = fakePlane();
    await serveJsonRpc(plane.socket, application, encodeJsonRpcRequest("req-7", "ping", { n: 1 }), "conn-9");
    await serveJsonRpc(plane.socket, application, "not-json", "conn-9");
    await serveJsonRpc(plane.socket, application, JSON.stringify({ jsonrpc: "1.0" }), "conn-9");
    expect({ seen, texts: plane.texts }).toEqual({
      seen: [
        {
          method: "ping",
          args: { n: 1 },
          identity: { requestId: "req-7", connectionId: "conn-9" },
        },
      ],
      texts: [
        encodeJsonRpcResult("req-7", { pong: true }),
        encodeJsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"),
        encodeJsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"),
      ],
    });
  });

  it("does not reply to notifications; method errors keep the request id", async () => {
    const plane = fakePlane();
    const application: RpcApplication = {
      async handleRequest() {
        throw new RpcMethodNotFound("nope");
      },
    };
    await serveJsonRpc(plane.socket, application, JSON.stringify({ jsonrpc: "2.0", method: "nope" }), "conn-n");
    await serveJsonRpc(plane.socket, application, encodeJsonRpcRequest(8, "nope", {}), "conn-n");
    expect(plane.texts).toEqual([encodeJsonRpcError(8, JSON_RPC_METHOD_NOT_FOUND, "Method not found: nope")]);
  });
});
