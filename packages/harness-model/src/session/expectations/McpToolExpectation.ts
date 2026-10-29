/**
 * One MCP `tools/call`. Rides the MCP connection named `connectionId`.
 * Settlement stamps the enclosing ToolCallJob receipt. Seal (`completed`) is the Job executor.
 */
import { syncing } from "@here.build/plexus";
import { WorkExpectation, type EndCause } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import { serializingInto } from "../../json-record.js";
import type { ToolOutcomeSnap } from "../../schemas/index.js";
import { parseOutcomeValue, stringifyOutcomeValue } from "../jobs/CallOutcome.js";
import { ToolCallJob } from "../jobs/ToolCallJob.js";

export type McpToolResult = {
  readonly ok: boolean;
  readonly text?: string;
  readonly value?: unknown;
};

@syncing("harness:expectation:mcp-tool")
export class McpToolExpectation extends WorkExpectation<McpToolResult, McpToolResult> {
  @syncing accessor serverToolName: string = "";
  @syncing accessor argsJson: string | null = "{}";
  @syncing private accessor valueJson: string | null = null;
  @syncing accessor dispatched: boolean = false;

  constructor(
    props:
      | symbol
      | {
          connectionId: string;
          serverToolName?: string;
          argsJson?: string | null;
        },
  ) {
    super(props);
  }

  @serializingInto("argsJson")
  accessor args: ReadonlyDeep<Record<string, unknown>> | null = null;

  @computed
  get value(): unknown {
    return parseOutcomeValue(this.valueJson);
  }

  set value(next: unknown) {
    this.valueJson = stringifyOutcomeValue(next);
  }

  override applySettlement(result: McpToolResult): void {
    this.value = result.value;
    sealEnclosingToolCall(this, snapOf(result));
  }

  @syncing.action
  markDispatched(): void {
    this.dispatched = true;
  }

  @syncing.action
  override fail(cause: EndCause, detail: string, outcomeReport: string): boolean {
    const wrote = super.fail(cause, detail, outcomeReport);
    if (wrote) {
      sealEnclosingToolCall(this, {
        ok: false,
        text: cause === "cancel" || detail === "terminate" ? "cancelled" : detail,
      });
    }
    return wrote;
  }
}

function snapOf(result: McpToolResult): ToolOutcomeSnap {
  return {
    ok: result.ok,
    ...(typeof result.text === "string" ? { text: result.text } : {}),
    ...(result.value === undefined ? {} : { value: result.value }),
  };
}

function sealEnclosingToolCall(from: McpToolExpectation, outcome: ToolOutcomeSnap): void {
  const parent = from.parent;
  if (!(parent instanceof ToolCallJob)) return;
  parent.outcomeSnap ??= outcome;
}
