/**
 * Human inject at a model-input boundary. Render is `steerText`; the model
 * sees a user-role cell.
 */
import { syncing } from "@here.build/plexus";
import { prompt, type UserPrompt } from "@inhuman.tools/harness-commons";
import { WorkContainer } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

@syncing("harness:session:turn-steer")
export class TurnSteerChunk extends WorkContainer {
  get work(): WorkContainer[] {
    return [];
  }
  @syncing accessor text: UserPrompt = prompt.user``;
  /**
   * Model-facing text when it differs from {@link text}. Null on an ordinary
   * steer. Skill expansion stores the injection here.
   */
  @syncing accessor derivedMessage: UserPrompt | null = null;
  @syncing accessor composedAtMs: number = 0;
  @syncing accessor composedAgainst: string = "";

  constructor(
    props?:
      | {
          readonly text?: UserPrompt;
          readonly derivedMessage?: UserPrompt | null;
          readonly composedAtMs?: number;
          readonly composedAgainst?: string;
        }
      | symbol,
  ) {
    super(props);
  }

  /** What the model reads. Consumers use this, not `text` and not `derivedMessage`. */
  @computed
  get completionMessage(): UserPrompt {
    return this.derivedMessage ?? this.text;
  }

  steerText(): string {
    return this.text;
  }
}
