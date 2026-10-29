import { syncing } from "@here.build/plexus";
import { WorkContainer } from "@inhuman.tools/plexus-expectations";

@syncing("harness:session:turn-prompt")
export class TurnPromptChunk extends WorkContainer {
  get work(): WorkContainer[] {
    return [];
  }

  constructor(props?: Record<string, never> | symbol) {
    super(props);
  }
}
