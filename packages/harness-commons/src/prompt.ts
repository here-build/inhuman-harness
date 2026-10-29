/**
 * Compile-time prompt brand. Runtime and Plexus stay `string`.
 * `` prompt`…` `` is either kind; `` prompt.system` `` / `` prompt.user` ``
 * do not assign to each other.
 *
 * Sole home. plugin-sdk and harness-sdk re-export the same symbols.
 *
 * A source-indented tag (opening newline) is `dedent`ed after `String.raw`
 * so author indent does not leak onto the model wire. A single-line tag
 * and `as*` keep the string as written — a two-space blank pin stays a pin.
 */
import dedent from "dedent";
import type { Tagged } from "type-fest";

export type PromptKind = "system" | "user";
export type Prompt<K extends PromptKind = PromptKind> = Tagged<string, "prompt", K>;
export type SystemPrompt = Prompt<"system">;
export type UserPrompt = Prompt<"user">;

function tagPrompt<K extends PromptKind>(strings: TemplateStringsArray, values: readonly unknown[]): Prompt<K> {
  const raw = String.raw({ raw: strings }, ...values);
  return (strings[0]?.startsWith("\n") === true ? dedent(raw) : raw) as Prompt<K>;
}

function promptLiteral(strings: TemplateStringsArray, ...values: unknown[]): Prompt {
  return tagPrompt(strings, values);
}

function systemLiteral(strings: TemplateStringsArray, ...values: unknown[]): SystemPrompt {
  return tagPrompt(strings, values);
}

function userLiteral(strings: TemplateStringsArray, ...values: unknown[]): UserPrompt {
  return tagPrompt(strings, values);
}

export const prompt: typeof promptLiteral & {
  readonly system: typeof systemLiteral;
  readonly user: typeof userLiteral;
} = Object.assign(promptLiteral, {
  system: systemLiteral,
  user: userLiteral,
});

export function asPrompt(text: string): Prompt {
  return text as Prompt;
}

export function asSystemPrompt(text: string): SystemPrompt {
  return text as SystemPrompt;
}

export function asUserPrompt(text: string): UserPrompt {
  return text as UserPrompt;
}
