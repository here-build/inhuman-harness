/**
 * Licensed `web_search` call. Identity and receipt live on {@link ToolCallJob}.
 * BODY intern's {@link WebSearchExpectation} after an allow-side guard.
 * Leftover intern PEW is a pre-set `expectation`; new BODY does not mint
 * when it is already set. Retries replace (do not append).
 */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type UnknownOutcomeRecovery, WorkContainer } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { ToolCallJob, type ToolCallJobProps } from "./ToolCallJob.js";
import { webSearchArgsSchema } from "../../schemas/web-search.js";
import { WebSearchExpectation } from "../expectations/WebSearchExpectation.js";

/** Model-facing tool name. Not a DriverSpec.abilityClaim token. */
export const WEB_SEARCH_TOOL_NAME = "web_search";

@syncing("harness:job:web-search")
export class WebSearchToolJob extends ToolCallJob {
  override readonly owner: JobEffectOwner = "tool-runtime";
  override readonly intent: string =
    "Record job/attempt identity, runtime generation, query/limit, connectionKey; await a durable receipt before provider search.";
  override readonly checkpoint: string =
    "session document prefix including orchestrationResult. expectation.startedAtMs is not a receipt.";
  override readonly dispatch: string =
    "instance.webSearch after connection pick. Leftover PEW started && !done waits; no second dispatch.";
  override readonly settlement: string = "outcomeJson + expectation.isDone + completed.";
  override readonly cancel: string =
    "Abort stamps a failure receipt and terminates leftover PEW. Park does not replay.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string =
    "Durable unsettled intent or leftover in-flight PEW is unknown, not queued work.";
  override readonly intentRequired: boolean = true;

  /** Kernel ConnectionSpec key — picked at intern, not admit. */
  @syncing accessor connectionKey: string = "";
  /** Leftover intern PEW is a pre-set `expectation`; new BODY does not mint when it is already set. */
  @syncing.child accessor expectation!: WebSearchExpectation;

  constructor(
    props:
      | (ToolCallJobProps & {
          readonly connectionKey?: string;
          readonly expectation: WebSearchExpectation;
        })
      | symbol,
  ) {
    super(props);
  }

  @computed
  override get work(): readonly WorkContainer[] {
    return [this.expectation, ...this.children];
  }

  @computed
  get #search(): { readonly query: string; readonly limit: number } {
    return parseWebSearchArgs(this.args);
  }

  @computed
  get query(): string {
    return this.#search.query;
  }

  @computed
  get limit(): number {
    return this.#search.limit;
  }
}

export function parseWebSearchArgs(argsJson: unknown): { readonly query: string; readonly limit: number } {
  const parsed = webSearchArgsSchema.safeParse(argsJson);
  return parsed.success ? parsed.data : { query: "", limit: 5 };
}
