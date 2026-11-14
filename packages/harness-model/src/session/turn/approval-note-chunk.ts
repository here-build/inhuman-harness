/**
 * Human license speech at the next model-input boundary. One cell per
 * noted leaf. The model sees a user-role message after that round's tool
 * results. Tape paint reads `approvalComment` on the leaf — this chunk is
 * not a watch-surface row.
 */
import { WorkContainer } from "@inhuman.tools/expectations";
import { prompt, type UserPrompt } from "@inhuman.tools/harness-commons";
import { model, state } from "@inhuman.tools/model";

@model("harness:session:turn-approval-note")
export class TurnApprovalNoteChunk extends WorkContainer {
  get work(): WorkContainer[] {
    return [];
  }
  @state accessor leafId: string = "";
  @state accessor toolName: string = "";
  @state accessor allowed: boolean = false;
  @state accessor text: UserPrompt = prompt.user``;

  constructor(
    props?:
      | {
          readonly leafId?: string;
          readonly toolName?: string;
          readonly allowed?: boolean;
          readonly text?: UserPrompt;
        }
      | symbol,
  ) {
    super(props);
  }

  approvalNoteText(): string {
    const name = this.toolName.trim();
    const identity = name === "" ? "this tool use" : `this tool use (${name})`;
    const verb = this.allowed ? "allowed" : "refused";
    return `The user ${verb} ${identity} with this note:\n<note>\n${this.text}\n</note>`;
  }
}
