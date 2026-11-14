import { WorkContainer } from "@inhuman.tools/expectations";
import { model } from "@inhuman.tools/model";

@model("harness:session:turn-prompt")
export class TurnPromptChunk extends WorkContainer {
  get work(): WorkContainer[] {
    return [];
  }

  constructor(props?: Record<string, never> | symbol) {
    super(props);
  }
}
