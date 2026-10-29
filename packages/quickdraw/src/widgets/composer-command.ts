/**
 * Composer command catalog + match.
 *
 * Pure. The widget paints the match; the worker calls the same matcher so
 * autocomplete can notify on a prefix hit (`/conn` → `/connect` is active)
 * without a function on the layout node.
 *
 * {@link autocompleteRemainder} is the dim suffix after the caret. It is not
 * draft: caret, copy, and Tab rewrite stay on the typed prefix.
 */

import { catalogKey } from "./composer-picker.js";
import type { ChromeHotkey } from "../layout/paint-hotkey.js";

export type ComposerCommand = {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
};

export type ComposerCommandAction = {
  readonly name: string;
  readonly displayName: string;
  readonly hotkey?: string;
};

export type ComposerCommandChoice = {
  readonly key?: string;
  readonly name: string;
  readonly status?: string;
  readonly annotation?: string;
  readonly description?: string;
  readonly actionDisplayName?: string;
  readonly actions: readonly ComposerCommandAction[];
  /** When set, the panel paints this URL as an accent+underline link. */
  readonly href?: string;
};

/** Fallback row when choices are empty or the catalog missed. */
export type ComposerCommandFallback = {
  readonly name: string;
  readonly displayName: string;
  readonly actions: readonly ComposerCommandAction[];
  readonly href?: string;
};

export type ComposerCommandMatch = {
  readonly matches: readonly ComposerCommand[];
  readonly selected: ComposerCommand | null;
  readonly selectedIndex: number;
};

function verbToken(inputValue: string): string {
  const first = (inputValue.split("\n")[0] ?? "").trim();
  if (!first.startsWith("/")) return "";
  return (first.split(/\s/)[0] ?? "").slice(1).toLowerCase();
}

function commandNames(cmd: ComposerCommand): readonly string[] {
  const names = [cmd.name, ...(cmd.aliases ?? [])];
  return names.map((n) => n.replace(/^\//, "").toLowerCase());
}

/**
 * Dim suffix after the typed prefix for the highlighted picker row.
 *
 * Catalog names start with `/` and complete the verb (`/con` → `nect`).
 * Choice names do not: a bare verb gets a separating space (`/connect` →
 * ` LM Studio`); a prefix of the name — spaces included — gets only the rest
 * (`LM St` → `udio`). Empty when the prefix is already exact, is not a prefix
 * of the name, or the draft is not a single-line slash command.
 */
export function autocompleteRemainder(inputValue: string, selectedName: string): string {
  if (inputValue.includes("\n")) return "";
  const choice = selectedName.trim();
  if (choice.length === 0) return "";
  const rest = inputValue.replace(/^\s*/, "");
  if (!rest.startsWith("/")) return "";

  const sp = rest.search(/\s/);
  if (choice.startsWith("/")) {
    if (sp >= 0) return "";
    if (!startsWithInsensitive(choice, rest)) return "";
    return choice.slice(rest.length);
  }

  if (sp < 0) return ` ${choice}`;
  const args = rest.slice(sp + 1);
  if (!startsWithInsensitive(choice, args)) return "";
  return choice.slice(args.length);
}

function startsWithInsensitive(full: string, prefix: string): boolean {
  return full.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Prefix match against `commands`. Empty draft / no leading `/` → no match.
 * Selected is the first match (caller may override with an index).
 */
export function matchComposerCommand(inputValue: string, commands: readonly ComposerCommand[]): ComposerCommandMatch {
  const token = verbToken(inputValue);
  if (token.length === 0 && !(inputValue.split("\n")[0] ?? "").trim().startsWith("/")) {
    return { matches: [], selected: null, selectedIndex: 0 };
  }
  const matches =
    token.length === 0 ? commands : commands.filter((c) => commandNames(c).some((n) => n.startsWith(token)));
  const selected = matches[0] ?? null;
  return {
    matches,
    selected,
    selectedIndex: selected ? 0 : 0,
  };
}

export function commandToChoice(cmd: ComposerCommand): ComposerCommandChoice {
  const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
  return {
    key: catalogKey(name),
    name,
    description: cmd.description,
    actions: [{ name: "select", displayName: "select", hotkey: "Enter" }],
  };
}

/** Chord/action pairs for the omnibox strip. */
export function actionHotkeys(actions: readonly ComposerCommandAction[] | undefined): ChromeHotkey[] | undefined {
  if (actions === undefined) return undefined;
  const out: ChromeHotkey[] = [];
  for (const action of actions) {
    const key = paintHotkey((action.hotkey ?? "").trim());
    if (key.length === 0) continue;
    const label = (action.displayName || action.name).trim();
    if (label.length === 0) continue;
    out.push({ key, action: label, event: action.name });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * STRIP vs STORAGE. Stored chords stay `escape` / `control-x` so
 * `eventMatchesChord` matches. This function is display-only: the strip
 * writes `Esc` / `Ctrl-x`. Normalizing storage to the strip form breaks matching.
 */
function paintHotkey(hotkey: string): string {
  return hotkey
    .split("-")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "escape") return "Esc";
      if (lower === "control") return "Ctrl";
      return part;
    })
    .join("-");
}

export function fallbackToChoice(action: ComposerCommandFallback): ComposerCommandChoice {
  return {
    name: action.displayName || action.name,
    description: action.name,
    actions: action.actions,
    actionDisplayName: action.actions[0]?.displayName,
    href: action.href,
  };
}
