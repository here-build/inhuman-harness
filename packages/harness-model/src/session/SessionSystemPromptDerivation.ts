/**
 * Sparse overlay of {@link SessionSystemPrompt}. Null packet = inherit.
 * Inside `env`, a null value invalidates that key (records cannot store undefined).
 * Empty `tools`/`skills` inherit — child lists cannot be null.
 */
import { prompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import { Model, model, state } from "@inhuman.tools/model";

import { SkillSpec, ToolSpec } from "./prompt-parts.js";
import type { SystemPromptParts } from "./SessionSystemPrompt.js";

@model("harness:session:system-prompt-derivation")
export class SessionSystemPromptDerivation extends Model {
  @state accessor reason: string = "";
  @state accessor constitution: SystemPrompt | null = null;
  /** One-shot system line for this turn. Not a prompt part; does not inherit. */
  @state accessor note: SystemPrompt = prompt.system``;
  @state.record accessor env: Record<string, string | null> = {};
  @state.childList accessor tools: ToolSpec[] = [];
  @state.childList accessor skills: SkillSpec[] = [];

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
