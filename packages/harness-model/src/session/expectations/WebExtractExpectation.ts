/**
 * One URL→markdown attempt. Rides the web-extract connection named `connectionId`.
 * Settlement stamps the enclosing ToolCallJob receipt. Seal is the Job executor.
 */
import { WorkExpectation, type EndCause } from "@inhuman.tools/expectations";
import { model, state } from "@inhuman.tools/model";
import { computed } from "mobx";

import type { ToolOutcomeSnap } from "../../schemas/index.js";
import { parseOutcomeValue, stringifyOutcomeValue } from "../jobs/CallOutcome.js";
import { ToolCallJob } from "../jobs/ToolCallJob.js";

export type WebExtractValue = {
  readonly url: string;
  readonly requestedUrl?: string;
  readonly sourceUrl?: string;
  readonly provenance?: "unavailable" | "provider-reported";
  readonly title?: string;
  readonly markdown: string;
  readonly provider?: string;
  readonly truncated?: boolean;
};

export type WebExtractResult = {
  readonly ok: boolean;
  readonly text?: string;
  readonly value?: WebExtractValue;
};

@model("harness:expectation:web-extract")
export class WebExtractExpectation extends WorkExpectation<WebExtractResult, WebExtractResult> {
  @state accessor url: string = "";
  @state accessor charLimit: number = 15_000;
  @state private accessor valueJson: string | null = null;

  constructor(
    props:
      | symbol
      | {
          connectionId: string;
          url?: string;
          charLimit?: number;
        },
  ) {
    super(props);
  }

  @computed
  get value(): unknown {
    return parseOutcomeValue(this.valueJson);
  }

  set value(next: unknown) {
    this.valueJson = stringifyOutcomeValue(next);
  }

  override applySettlement(result: WebExtractResult): void {
    this.value = result.value;
    sealEnclosingToolCall(this, snapOf(result));
  }

  @state.action
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

function snapOf(result: WebExtractResult): ToolOutcomeSnap {
  return {
    ok: result.ok,
    ...(typeof result.text === "string" ? { text: result.text } : {}),
    ...(result.value === undefined ? {} : { value: result.value }),
  };
}

function sealEnclosingToolCall(from: WebExtractExpectation, outcome: ToolOutcomeSnap): void {
  const parent = from.parent;
  if (!(parent instanceof ToolCallJob)) return;
  parent.outcomeSnap ??= outcome;
}
