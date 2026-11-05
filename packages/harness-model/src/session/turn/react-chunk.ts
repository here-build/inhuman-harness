import { model, state } from "@inhuman.tools/model";
import { WorkContainer } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import type { IntentAssessment, RoundDecision } from "./round-decision.js";
import { deepFreeze } from "../../json-record.js";
import type { CompletionJob } from "../jobs/CompletionJob.js";

export type RoundContextNote = { readonly id: string; readonly text: string; readonly mode: "ambient" | "activating" };

@model("harness:session:react")
export class ReACTChunk extends WorkContainer {
  /** A durable settlement boundary, not permission to invoke the model. Ref, never owner. */
  @state.ref accessor source: CompletionJob | null = null;
  /** Ref committed with turn admission; UUID is read only after materialization. */
  @state.ref accessor successor: CompletionJob | null = null;
  @state private accessor decisionJson: string | null = null;
  @state private accessor intentJson: string | null = null;
  @state private accessor notesJson: string = "[]";
  /** Context that authorized/enriched this boundary survives a new runtime's empty NoteLog. */
  @computed get contextNotes(): readonly RoundContextNote[] {
    return deepFreeze(JSON.parse(this.notesJson) as RoundContextNote[]);
  }
  set contextNotes(value: readonly RoundContextNote[]) {
    this.notesJson = JSON.stringify(value);
  }
  @computed get decision(): RoundDecision | null {
    if (this.decisionJson == null) return null;
    const decision = JSON.parse(this.decisionJson) as RoundDecision;
    return deepFreeze(this.successor == null ? decision : { ...decision, nextRoundId: this.successor.uuid });
  }
  set decision(value: RoundDecision | null) {
    this.decisionJson = value == null ? null : JSON.stringify(value);
  }
  @computed get intentAssessment(): IntentAssessment | null {
    return this.intentJson == null ? null : deepFreeze(JSON.parse(this.intentJson) as IntentAssessment);
  }
  set intentAssessment(value: IntentAssessment | null) {
    this.intentJson = value == null ? null : JSON.stringify(value);
  }
  /** Round hooks are entered at most once per wrap; a parked boundary remains resumable. */
  @state accessor roundClosed: boolean = false;
  /** Admission can wait without granting another invocation or losing its causes. */
  @state accessor waitingFor: "" | "inbound" | "round-hook" = "";
  get work(): WorkContainer[] {
    return [];
  }

  /**
   * Legacy tape compatibility. New boundaries use source + decision.
   */
  @state accessor openPage: boolean = false;
  /** A conditional continuation resolved without opening another model round. */
  @state accessor skipped: boolean = false;

  /**
   * Text-only intern nudge. Not OPEN PAGE. Reducer keeps this round and
   * stamps the intern system note.
   */
  @state accessor intentContinue: boolean = false;

  /**
   * The previous round stopped on the provider's output limit. This round
   * continues it; the stop reason is a fact on that completion.
   */
  @state accessor truncated: boolean = false;

  constructor(
    props?:
      | {
          readonly source?: CompletionJob | null;
          readonly decisionJson?: string | null;
          readonly openPage?: boolean;
          readonly intentContinue?: boolean;
          readonly truncated?: boolean;
          readonly skipped?: boolean;
        }
      | symbol,
  ) {
    super(props);
  }
}
