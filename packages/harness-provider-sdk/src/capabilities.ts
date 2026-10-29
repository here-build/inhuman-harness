/**
 * Known capability kinds and request/result envelopes.
 *
 * `can` on a driver is these short names (product law). PEW/model kinds stay
 * the existing Expectation classes — v1 does not invent third-party wire kinds.
 */
import type {
  CompletionExpectation,
  CompletionMessage,
  CompletionResult,
  McpToolResult,
  WebExtractResult,
  WebSearchResult,
} from "@inhuman.tools/harness-model";

import { parseWith } from "./parse.js";
import { CAPABILITY_KINDS, capabilityKindSchema, capabilityRequestSchema } from "./schemas/provider.js";

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** Sync tags of the harness-model PEW kinds each `can` token claims. */
export const CAPABILITY_EXPECTATION = {
  completion: "harness:expectation:completion",
  mcp: "harness:expectation:mcp-tool",
  "web-search": "harness:expectation:web-search",
  "web-extract": "harness:expectation:web-extract",
} as const satisfies Record<CapabilityKind, string>;

export const CAPABILITY_METHOD = {
  completion: "complete",
  mcp: "callTool",
  "web-search": "webSearch",
  "web-extract": "webExtract",
} as const satisfies Record<CapabilityKind, string>;

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return capabilityKindSchema.safeParse(value).success;
}

export function parseCapabilityKind(value: unknown): CapabilityKind {
  return parseWith(capabilityKindSchema, value);
}

export function admitCapability(can: readonly string[], kind: CapabilityKind): boolean {
  return can.includes(kind);
}

export type CompleteFields = {
  readonly model: string;
  readonly promptText?: string;
  readonly messages?: CompletionMessage[];
  readonly responseSchemaJson?: string;
  readonly systemNote?: string;
  readonly signal?: AbortSignal;
  /** Required. Homed on a session plexus. Mutated in place. */
  readonly round: CompletionExpectation;
};

export type CompleteRequest = CompleteFields & {
  readonly connectionId: string;
};
export type ConnectionCompleteRequest = CompleteFields;
export type CompleteResult = CompletionResult;

export type McpCallRequest = {
  readonly connectionId: string;
  readonly serverToolName: string;
  readonly args: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly onDispatch?: () => void;
};
export type ConnectionMcpCallRequest = Omit<McpCallRequest, "connectionId">;
export type McpCallResult = McpToolResult;

export type WebSearchRequest = {
  readonly connectionId: string;
  readonly query: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
};
export type ConnectionWebSearchRequest = Omit<WebSearchRequest, "connectionId">;
export type WebSearchCapabilityResult = WebSearchResult;

export type WebExtractRequest = {
  readonly connectionId: string;
  readonly url: string;
  readonly charLimit?: number;
  readonly signal?: AbortSignal;
};
export type ConnectionWebExtractRequest = Omit<WebExtractRequest, "connectionId">;
export type WebExtractCapabilityResult = WebExtractResult;

export type CapabilityRequest =
  | { readonly kind: "completion"; readonly request: CompleteRequest }
  | { readonly kind: "mcp"; readonly request: McpCallRequest }
  | { readonly kind: "web-search"; readonly request: WebSearchRequest }
  | { readonly kind: "web-extract"; readonly request: WebExtractRequest };

export type CapabilityResult =
  | { readonly kind: "completion"; readonly result: CompleteResult }
  | { readonly kind: "mcp"; readonly result: McpCallResult }
  | { readonly kind: "web-search"; readonly result: WebSearchCapabilityResult }
  | {
      readonly kind: "web-extract";
      readonly result: WebExtractCapabilityResult;
    };

/**
 * Duck-typed interned connection face. Generic admission uses this, not a
 * vendor `instanceof`.
 */
export type CapabilityConnection = {
  readonly connectionId: string;
  complete?(req: ConnectionCompleteRequest): Promise<CompleteResult>;
  callTool?(req: ConnectionMcpCallRequest): Promise<McpCallResult>;
  webSearch?(req: ConnectionWebSearchRequest): Promise<WebSearchCapabilityResult>;
  webExtract?(req: ConnectionWebExtractRequest): Promise<WebExtractCapabilityResult>;
};

export function parseCapabilityRequest(value: unknown): CapabilityRequest {
  return parseWith(capabilityRequestSchema, value) as CapabilityRequest;
}

export function connectionSupports(connection: CapabilityConnection, kind: CapabilityKind): boolean {
  const method = CAPABILITY_METHOD[kind];
  return typeof connection[method] === "function";
}
