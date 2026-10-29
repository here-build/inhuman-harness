/**
 * Shared MCP connection: instance state reports tools; the class (driver)
 * state does not. Transport subclasses spawn or dial; this class owns the
 * SDK client connect + listTools. Interned `callTool` is the send door.
 */
import { fail } from "@inhuman.tools/harness-diagnostics";
import type { McpToolExpectation, McpToolResult } from "@inhuman.tools/harness-model";
import { ConnectionMiss, type ExpectationActor, PEWDriver } from "@inhuman.tools/plexus-expectations/driver";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { computed, observable, when } from "mobx";

import { mcpCallResult, withMcpStderr } from "./mcp-result.js";
import type { McpListedTool } from "./schemas/mcp.js";
import { mcpToolAllowed, mcpToolsSettingOf } from "./tool-filter.js";

export abstract class McpDriverConnection<
  C extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> extends PEWDriver<McpToolExpectation, C> {
  @observable.shallow override accessor state: {
    tools: McpListedTool[];
    auth: string | undefined;
  } = {
    tools: [],
    auth: undefined,
  };

  client: Client | null = null;

  stderrTail(): string {
    return "";
  }

  @computed
  get expiring(): boolean {
    return false;
  }

  @computed
  get needsAuth(): boolean {
    return this.state.auth === "needs-auth";
  }

  @computed
  get fresh(): boolean {
    return !this.needsAuth;
  }

  /**
   * Wait send-ready, then `client.request` (`tools/call`). `onDispatch` fires
   * immediately before the request so park can see `MCPToolJob.dispatched`.
   */
  async callTool(req: {
    readonly serverToolName: string;
    readonly args: Record<string, unknown>;
    readonly signal?: AbortSignal;
    readonly onDispatch?: () => void;
  }): Promise<McpToolResult> {
    const waitSignal = req.signal;
    const sendReady = (): boolean =>
      (this.readyState === "ready" && this.fresh) || this.needsAuth || this.readyState === "failed";
    try {
      await (waitSignal === undefined ? when(sendReady) : when(sendReady, { signal: waitSignal }));
    } catch (error) {
      if (waitSignal?.reason instanceof ConnectionMiss) throw waitSignal.reason;
      throw error;
    }
    if (this.needsAuth) {
      throw new ConnectionMiss("needs-auth", `connection ${this.connectionId} needs auth`);
    }
    if (this.readyState === "failed" || !this.fresh) {
      throw new ConnectionMiss("not-ready", `connection ${this.connectionId} is not send-ready`);
    }
    const tool = req.serverToolName.trim();
    if (tool === "") return { ok: false, text: "mcp: serverToolName is required" };
    if (!mcpToolAllowed(mcpToolsSettingOf(this.settings), tool)) {
      return { ok: false, text: `unknown MCP tool "${tool}"` };
    }
    const client = this.client;
    if (client === null) {
      throw new ConnectionMiss("not-ready", `connection ${this.connectionId} has no MCP client`);
    }
    req.onDispatch?.();
    try {
      const res: unknown = await client.request(
        { method: "tools/call", params: { name: tool, arguments: req.args } },
        CallToolResultSchema,
        { signal: req.signal },
      );
      const result = mcpCallResult(res);
      if (result.ok) return { ok: true, value: result.value };
      return {
        ok: false,
        text: this.decorateCallFailure(result.text ?? "mcp: tool reported failure"),
        ...(result.value === undefined ? {} : { value: result.value }),
      };
    } catch (error) {
      if (req.signal?.aborted) throw error;
      return { ok: false, text: this.decorateCallError(error) };
    }
  }

  protected decorateCallFailure(text: string): string {
    return withMcpStderr(text, this.stderrTail());
  }

  protected decorateCallError(error: unknown): string {
    return withMcpStderr(`mcp: ${error instanceof Error ? error.message : String(error)}`, this.stderrTail());
  }

  protected override resolve(expectation: McpToolExpectation): ExpectationActor<McpToolExpectation> {
    return this.createToolActor(expectation);
  }

  protected abstract createToolActor(expectation: McpToolExpectation): ExpectationActor<McpToolExpectation>;

  protected async connectMcpClient(transport: Transport): Promise<Client> {
    const client = new Client({ name: "harness-mcp", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  protected async requestMcpListTools(client: Client): Promise<readonly McpListedTool[]> {
    const result = await client.listTools();
    const seen = new Set<string>();
    return (result.tools ?? []).flatMap((tool) => {
      if (seen.has(tool.name)) {
        fail(`mcp ${this.connectionId}`, `server lists tool ${tool.name} twice; keeping the first`);
        return [];
      }
      seen.add(tool.name);
      const readish = /^(read|list|search|get|find|stat|info)/i.test(tool.name);
      return {
        serverToolName: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        class: readish ? "read" : "write",
      };
    });
  }
}
