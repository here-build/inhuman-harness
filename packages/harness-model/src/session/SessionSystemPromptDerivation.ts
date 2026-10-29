/**
 * Sparse overlay of {@link SessionSystemPrompt}. Null packet = inherit.
 * Inside `env`, a null value invalidates that key (records cannot store undefined).
 * Empty `tools`/`skills` inherit — child lists cannot be null.
 */
import { PlexusModel, syncing } from "@here.build/plexus";
import { prompt, type SystemPrompt } from "@inhuman.tools/harness-commons";

import { SkillSpec, ToolSpec } from "./prompt-parts.js";
import type { SystemPromptParts } from "./SessionSystemPrompt.js";

@syncing("harness:session:system-prompt-derivation")
export class SessionSystemPromptDerivation extends PlexusModel {
  @syncing accessor reason: string = "";
  @syncing accessor constitution: SystemPrompt | null = null;
  /** One-shot system line for this turn. Not a prompt part; does not inherit. */
  @syncing accessor note: SystemPrompt = prompt.system``;
  @syncing.record accessor env: Record<string, string | null> = {};
  @syncing.child.list accessor tools: ToolSpec[] = [];
  @syncing.child.list accessor skills: SkillSpec[] = [];

  apply(base: SystemPromptParts): SystemPromptParts {
    const env: Record<string, string> = { ...base.env };
    for (const [key, value] of Object.entries(this.env)) {
      if (value == null) delete env[key];
      else env[key] = value;
    }
    return {
      constitution: this.constitution ?? base.constitution,
      env,
      tools: this.tools.length > 0 ? this.tools : base.tools,
      skills: this.skills.length > 0 ? this.skills : base.skills,
    };
  }

  constructor(
    props?:
      | {
          readonly reason?: string;
          readonly constitution?: SystemPrompt | null;
          readonly note?: SystemPrompt;
          readonly env?: Record<string, string | null>;
          readonly tools?: ToolSpec[];
          readonly skills?: SkillSpec[];
        }
      | symbol,
  ) {
    super(props);
  }
}
