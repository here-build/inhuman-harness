/**
 * One web-search attempt. Rides the web-search connection named `connectionId`.
 * Settlement stamps the enclosing ToolCallJob receipt. Seal is the Job executor.
 */
import { WorkExpectation, type EndCause } from "@inhuman.tools/expectations";
import { model, state } from "@inhuman.tools/model";
import { computed } from "mobx";

import type { ToolOutcomeSnap } from "../../schemas/index.js";
import { parseOutcomeValue, stringifyOutcomeValue } from "../jobs/CallOutcome.js";
import { ToolCallJob } from "../jobs/ToolCallJob.js";

export type WebSearchHit = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

export type WebSearchValue = {
  readonly results: readonly WebSearchHit[];
  readonly provider?: string;
};

export type WebSearchResult = {
  readonly ok: boolean;
  readonly text?: string;
  readonly value?: WebSearchValue;
};

@model("harness:expectation:web-search")
export class WebSearchExpectation extends WorkExpectation<WebSearchResult, WebSearchResult> {
  @state accessor query: string = "";
  @state accessor limit: number = 5;
  @state private accessor valueJson: string | null = null;

  constructor(
    props:
      | symbol
      | {
          connectionId: string;
          query?: string;
          limit?: number;
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

  override applySettlement(result: WebSearchResult): void {
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

function snapOf(result: WebSearchResult): ToolOutcomeSnap {
  return {
    ok: result.ok,
    ...(typeof result.text === "string" ? { text: result.text } : {}),
    ...(result.value === undefined ? {} : { value: result.value }),
  };
}

function sealEnclosingToolCall(from: WebSearchExpectation, outcome: ToolOutcomeSnap): void {
  const parent = from.parent;
  if (!(parent instanceof ToolCallJob)) return;
  parent.outcomeSnap ??= outcome;
}
