/**
 * Session inbox row. Kind is which list it sits on (`steerQueue` vs
 * `promptQueue`), not a timing enum. Not a Job — not `.work`.
 */
import { PlexusModel, syncing } from "@here.build/plexus";
import { prompt, type UserPrompt } from "@inhuman.tools/harness-commons";

@syncing("harness:session:admission")
export class SessionAdmission extends PlexusModel {
  @syncing accessor text: UserPrompt = prompt.user``;
  /**
   * Model-facing text when it differs from {@link text}. Null on an ordinary
   * row. Carried onto the turn or steer chunk at claim.
   */
  @syncing accessor derivedMessage: UserPrompt | null = null;
  /** Epoch ms. Plexus cannot store Date. */
  @syncing accessor composedAtMs: number = 0;
  /** Live turn uuid at admit. Empty on older documents. */
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
}
