/**
 * Licensed `web_extract` call. Identity and receipt live on {@link ToolCallJob}.
 * BODY intern's {@link WebExtractExpectation} after an allow-side guard.
 * Leftover intern PEW is a pre-set `expectation`; new BODY does not mint
 * when it is already set. Retries replace (do not append).
 */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type UnknownOutcomeRecovery, WorkContainer } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { ToolCallJob, type ToolCallJobProps } from "./ToolCallJob.js";
import { DEFAULT_EXTRACT_CHAR_LIMIT, webExtractArgsSchema } from "../../schemas/web-extract.js";
import { WebExtractExpectation } from "../expectations/WebExtractExpectation.js";

/** Model-facing tool name. Not a DriverSpec.abilityClaim token. */
export const WEB_EXTRACT_TOOL_NAME = "web_extract";

@syncing("harness:job:web-extract")
export class WebExtractToolJob extends ToolCallJob {
  override readonly owner: JobEffectOwner = "tool-runtime";
  override readonly intent: string =
    "Record job/attempt identity, runtime generation, url/charLimit, connectionKey; await a durable receipt before provider extract.";
  override readonly checkpoint: string =
    "session document prefix including orchestrationResult. expectation.startedAtMs is not a receipt.";
  override readonly dispatch: string =
    "instance.webExtract after connection pick. Leftover PEW started && !done waits; no second dispatch.";
  override readonly settlement: string = "outcomeJson + expectation.isDone + completed.";
  override readonly cancel: string =
    "Abort stamps a failure receipt and terminates leftover PEW. Park does not replay.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string =
    "Durable unsettled intent or leftover in-flight PEW is unknown, not queued work.";
  override readonly intentRequired: boolean = true;

  @syncing accessor connectionKey: string = "";
  /** Leftover intern PEW is a pre-set `expectation`; new BODY does not mint when it is already set. */
  @syncing.child accessor expectation!: WebExtractExpectation;

  constructor(
    props:
      | (ToolCallJobProps & {
          readonly connectionKey?: string;
          readonly expectation: WebExtractExpectation;
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
  get #extract(): { readonly url: string; readonly charLimit: number } {
    return parseWebExtractArgs(this.args);
  }

  @computed
  get url(): string {
    return this.#extract.url;
  }

  @computed
  get charLimit(): number {
    return this.#extract.charLimit;
  }
}

export function parseWebExtractArgs(argsJson: unknown): { readonly url: string; readonly charLimit: number } {
  const parsed = webExtractArgsSchema.safeParse(argsJson);
  return parsed.success ? parsed.data : { url: "", charLimit: DEFAULT_EXTRACT_CHAR_LIMIT };
}
