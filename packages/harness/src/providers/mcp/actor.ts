/**
 * Leftover honor path: interned `callTool` does the wire work.
 * `Client.callTool` validates outputSchema on the client and throws — send
 * stays `client.request` inside `callTool`.
 */
import type { McpToolExpectation } from "@inhuman.tools/harness-model";
import { ConnectionNotReady, DemandIncomplete, ExpectationActor } from "@inhuman.tools/plexus-expectations/driver";

import type { McpDriverConnection } from "./mcp-connection.js";

export class McpToolActor extends ExpectationActor<McpToolExpectation> {
  constructor(
    expectation: McpToolExpectation,
    override readonly driverConnection: McpDriverConnection,
  ) {
    super(expectation, driverConnection);
  }

  protected async run(): Promise<void> {
    const tool = this.expectation.serverToolName.trim();
    DemandIncomplete.invariant(tool !== "", "serverToolName");
    const args = this.expectation.args;
    DemandIncomplete.invariant(args !== null, "arguments");
    if (this.done || this.signal.aborted) return;
    try {
      const result = await this.driverConnection.callTool({
        serverToolName: tool,
        args,
        signal: this.signal,
        onDispatch: () => this.expectation.markDispatched(),
      });
      if (this.signal.aborted) return;
      this.complete(result);
    } catch (error) {
      if (this.signal.aborted) return;
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }
}

export class McpStdioToolActor extends McpToolActor {}

export class McpHttpToolActor extends McpToolActor {
  protected override async run(): Promise<void> {
    if (this.driverConnection.state.auth === "needs-auth") {
      this.fail("mcp: connection needs auth");
      return;
    }
    ConnectionNotReady.invariant(this.driverConnection.readyState === "ready", this.driverConnection.connectionId);
    await super.run();
  }
}
