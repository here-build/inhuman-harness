/**
 * The class is the driver; an instance is one live MCP stdio connection.
 * Load writes tools onto state. Work is handle → resolve → actor.
 * Spawn cwd is ConnectionSpec cwd only.
 */
import type { Readable } from "node:stream";

import type { McpToolExpectation } from "@inhuman.tools/harness-model";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { McpStdioToolActor } from "./actor.js";
import { isMcpEnabled } from "./config.js";
import { McpDriverConnection } from "./mcp-connection.js";
import { mcpSecretsSchema, mcpStdioConfigurationSchema, type McpStdioConnectionConfig } from "./schemas/mcp.js";
import { buildMcpChildEnvExtras, secretEnv, StderrRing } from "./stdio-env.js";

export class McpStdioDriverConnection extends McpDriverConnection<McpStdioConnectionConfig> {
  static override configurationSchema = mcpStdioConfigurationSchema;
  static override secretsSchema = mcpSecretsSchema;
  static override configurationLabel = "mcp-stdio";

  protected override createToolActor(expectation: McpToolExpectation): McpStdioToolActor {
    return new McpStdioToolActor(expectation, this);
  }

  #transport: StdioClientTransport | null = null;
  readonly #stderrRing = new StderrRing();
  #detachStderr: (() => void) | null = null;

  override stderrTail(): string {
    return this.#stderrRing.tail();
  }

  override async bootstrap(): Promise<void> {
    if (!isMcpEnabled(this.settings)) {
      this.state.tools = [];
      return;
    }
    const command = this.settings.command.trim();
    const cwd = this.settings.cwd?.trim();
    const env = buildMcpChildEnvExtras({
      secrets: secretEnv(this.secrets),
      envForward: this.settings.envForward,
    });
    this.#stderrRing.clear();
    const transport = new StdioClientTransport({
      command,
      args: this.settings.args ? [...this.settings.args] : undefined,
      cwd: cwd === "" ? undefined : cwd,
      env,
      stderr: "pipe",
    });
    const stderr = transport.stderr as Readable | null;
    const onStderrData = (chunk: Buffer | string): void => {
      this.#stderrRing.push(chunk);
    };
    if (stderr && typeof stderr.on === "function") {
      stderr.on("data", onStderrData);
      stderr.resume?.();
    }
    this.#detachStderr = () => {
      if (stderr && typeof stderr.off === "function") stderr.off("data", onStderrData);
    };
    const prevOnClose = transport.onclose;
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses onclose callback, not EventTarget
    transport.onclose = () => {
      try {
        prevOnClose?.();
      } catch {
        /* ignore */
      }
      if (this.#transport === transport) {
        this.client = null;
        this.#transport = null;
        this.#detachStderr?.();
        this.#detachStderr = null;
        if (this.bootstrapDone) this.failReady(new Error("mcp-stdio: transport closed"));
      }
    };
    let client;
    try {
      client = await this.connectMcpClient(transport);
      this.#transport = transport;
    } catch (error) {
      this.#detachStderr?.();
      this.#detachStderr = null;
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      const tail = this.#stderrRing.tail();
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(tail ? `mcp: connect failed: ${msg}\n--- stderr ---\n${tail}` : `mcp: connect failed: ${msg}`);
    }
    try {
      this.state.tools = [...(await this.requestMcpListTools(client))];
    } catch (error) {
      const tail = this.#stderrRing.tail();
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(tail ? `${msg}\n--- stderr ---\n${tail}` : msg);
    }
  }

  override async [Symbol.asyncDispose](): Promise<void> {
    const client = this.client;
    const transport = this.#transport;
    this.client = null;
    this.#transport = null;
    this.#detachStderr?.();
    this.#detachStderr = null;
    if (transport) {
      try {
        // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses onclose callback, not EventTarget
        transport.onclose = undefined;
      } catch {
        /* ignore */
      }
    }
    try {
      if (client && typeof client.close === "function") await client.close();
    } catch {
      /* ignore */
    }
    try {
      if (transport && typeof transport.close === "function") await transport.close();
    } catch {
      /* ignore */
    }
    this.#stderrRing.clear();
  }
}
