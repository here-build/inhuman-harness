import { describe, expect, it } from "vitest";

import {
  encodeJsonRpcError,
  encodeJsonRpcRequest,
  encodeJsonRpcResult,
  evalInput,
  isRpcContractError,
  isUiForm,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  jsonRpcRequest,
  jsonRpcResponse,
  kvSetInput,
  RpcClientError,
  turnInput,
  uiAnswerSchema,
} from "../rpc/index.js";

describe("rpc envelopes", () => {
  it("roundtrips request/result/error and classifies contract errors", () => {
    const request = jsonRpcRequest.parse(JSON.parse(encodeJsonRpcRequest(1, "eval", { requestId: "r1" })));
    const result = jsonRpcResponse.parse(JSON.parse(encodeJsonRpcResult(1, { ok: true })));
    const error = jsonRpcResponse.parse(
      JSON.parse(encodeJsonRpcError(1, JSON_RPC_INVALID_PARAMS, "eval requestId already admitted")),
    );
    expect({
      request,
      result,
      error,
      contract: isRpcContractError(new RpcClientError(JSON_RPC_INVALID_PARAMS, "x")),
      missing: isRpcContractError(new RpcClientError(JSON_RPC_METHOD_NOT_FOUND, "x")),
      transport: isRpcContractError(new Error("rpc: socket closed")),
      ui: isUiForm({ form: "ui", body: "ok", pending: "p1" }),
      answer: uiAnswerSchema.parse({ kind: "accept" }),
    }).toEqual({
      request: {
        jsonrpc: "2.0",
        id: 1,
        method: "eval",
        params: { requestId: "r1" },
      },
      result: { jsonrpc: "2.0", id: 1, result: { ok: true } },
      error: {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: JSON_RPC_INVALID_PARAMS,
          message: "eval requestId already admitted",
        },
      },
      contract: true,
      missing: true,
      transport: false,
      ui: true,
      answer: { kind: "accept" },
    });
  });
});

describe("rpc validation shapes", () => {
  it("parses method inputs without a domain host", () => {
    expect({
      turn: turnInput.parse({ prompt: "hi", kind: "steer" }),
      eval: evalInput.parse({ requestId: "r1", expr: "(+ 1 1)" }),
      remember: kvSetInput.parse({ key: "model", value: "grok", remember: "1" }).remember,
      source: evalInput.safeParse({
        requestId: "r1",
        expr: "x",
        source: "file",
      }).success,
    }).toEqual({
      turn: { prompt: "hi", kind: "steer" },
      eval: { requestId: "r1", expr: "(+ 1 1)", policy: "auto" },
      remember: true,
      source: false,
    });
  });
});
