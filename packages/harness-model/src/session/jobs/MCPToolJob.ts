/**
 * MCP tool call. Identity and receipt live on {@link ToolCallJob}.
 * BODY is the Job executor after an allow-side guard.
 * mints PEW honored by `connectionKey`. Leftover intern PEW is a pre-set
 * `expectation`; new BODY does not mint when it is already set. Retries
 * replace (do not append).
 */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type UnknownOutcomeRecovery, WorkContainer } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { ToolCallJob, type ToolCallJobProps } from "./ToolCallJob.js";
import type { CallSubject } from "../authorization/resolve.js";
import { McpToolExpectation } from "../expectations/McpToolExpectation.js";

@syncing("harness:job:mcp-tool")
export class MCPToolJob extends ToolCallJob {
  override readonly owner: JobEffectOwner = "tool-runtime";
  override readonly intent: string =
    "Record job/attempt identity, runtime generation, connectionKey, serverToolName, argsJson; await a durable receipt before tools/call.";
  override readonly checkpoint: string =
    "session document prefix including orchestrationResult. MCPToolJob.dispatched and expectation.dispatched are live park pins, not receipts.";
  override readonly dispatch: string =
    "Set dispatched immediately before interned callTool / leftover PEW dispatch. Same-runtime leftoverInFlight waits; it does not re-dispatch.";
  override readonly settlement: string =
    "outcomeJson + expectation.isDone + completed. Park holds on-wire MCP until settlement.";
  override readonly cancel: string =
    "Undispatched abort does not start MCP and does not write a cancel receipt for park. On-wire waits for settlement (one settlement).";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string =
    "Durable intent without result or dispatched-without-result: unknown. Do not mint a new attempt.";
  override readonly intentRequired: boolean = true;

  /** Kernel ConnectionSpec key — the MCP server this call rides. */
  @syncing accessor connectionKey: string = "";
  @syncing accessor serverToolName: string = "";
  /**
   * `tools/call` has left this process. Park waits when true.
   * Written immediately before interned `callTool` / leftover PEW dispatch.
   */
  @syncing accessor dispatched: boolean = false;
  /** Leftover intern PEW is a pre-set `expectation`; new BODY does not mint when it is already set. */
  @syncing.child accessor expectation!: McpToolExpectation;

  constructor(
    props:
      | (ToolCallJobProps & {
          readonly connectionKey?: string;
          readonly serverToolName?: string;
          readonly expectation: McpToolExpectation;
        })
      | symbol,
  ) {
    super(props);
  }

  @computed
  override get work(): readonly WorkContainer[] {
    return [this.expectation, ...this.children];
  }

  /** The account is the connection id: one ConnectionSpec is one account. */
  @computed
  override get grantMcp(): { readonly server: string; readonly account: string; readonly tool: string } {
    return { server: this.connectionKey, account: this.connectionKey, tool: this.serverToolName };
  }

  @computed
  override get callSubject(): CallSubject {
    return { ...super.callSubject, mcp: this.grantMcp };
  }
}
