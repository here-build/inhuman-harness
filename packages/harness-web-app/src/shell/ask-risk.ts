/**
 * What an approval is asking, in human terms, and whether Allow should look
 * destructive. The phrases are the hint; the button is the only color.
 */
import { workspacePath } from "@inhuman.tools/harness-model/session";

export type AskAct = {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>> | null;
  readonly projectPath: string;
  /** `write_file`: true when the path was already a file. */
  readonly existed?: boolean | null;
};

export type AskRisk = {
  readonly destructive: boolean;
  /** Empty when the ask is ordinary. One short sentence when it is not. */
  readonly phrase: string;
};

const PHRASE = {
  rm: "This deletes files.",
  clean: "This deletes untracked files.",
  mkfs: "This erases a disk.",
  dd: "This overwrites raw bytes.",
  reset: "This discards local changes.",
  push: "This rewrites remote history.",
  chmod: "This changes permissions recursively.",
  sudo: "This runs as root.",
  deleteOut: "This deletes files outside the project.",
  writeOut: "This writes outside the project.",
} as const;

type Phrase = (typeof PHRASE)[keyof typeof PHRASE];

/** Earlier loses to nothing. The first match in a script is not the worst match. */
const RANK: readonly Phrase[] = [
  PHRASE.rm,
  PHRASE.clean,
  PHRASE.mkfs,
  PHRASE.dd,
  PHRASE.reset,
  PHRASE.push,
  PHRASE.chmod,
  PHRASE.sudo,
  PHRASE.deleteOut,
  PHRASE.writeOut,
];

const WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "nice"]);

type Seen = { readonly sudo: boolean; readonly phrases: readonly Phrase[] };

/** The heading: the act, not the tool id. `toolName` is the human label when one exists. */
export function askHeading(act: AskAct, toolName: (name: string) => string = (name) => name): string {
  const verb = verbOf(act.name);
  const file = baseName(actPath(act.args));
  if (verb === "shell") return `Run a command in ${dirName(act.projectPath)}`;
  if (verb === "edit" || (verb === "write" && act.existed === true)) return `Edit ${file}`;
  if (verb === "write") return `Create ${file}`;
  if (verb === "delete") return `Delete ${file}`;
  const name = act.name.trim();
  if (name === "") return "Pending action";
  const label = toolName(name).trim();
  return `Use ${label === "" ? name : label}`;
}

export function askRisk(act: AskAct): AskRisk {
  const phrases: Phrase[] = [];
  const verb = verbOf(act.name);
  if (verb === "shell") {
    const command = stringArg(act.args, "command");
    if (command !== "") {
      const seen = walkScript(command, 0);
      phrases.push(...seen.phrases);
      if (seen.sudo) phrases.push(PHRASE.sudo);
    }
  }
  const path = actPath(act.args);
  if (path !== "" && outsideRoot(act.projectPath, path)) {
    if (verb === "delete") phrases.push(PHRASE.deleteOut);
    if (verb === "write" || verb === "edit") phrases.push(PHRASE.writeOut);
  }
  const phrase = worst(phrases);
  return phrase == null ? { destructive: false, phrase: "" } : { destructive: true, phrase };
}

function worst(phrases: readonly Phrase[]): Phrase | null {
  let best: Phrase | null = null;
  let rank = RANK.length;
  for (const phrase of phrases) {
    const at = RANK.indexOf(phrase);
    if (at !== -1 && at < rank) {
      rank = at;
      best = phrase;
    }
  }
  return best;
}

function verbOf(name: string): "shell" | "edit" | "write" | "delete" | "other" {
  const leaf = (name.split("__").pop() ?? name).trim().toLowerCase();
  if (leaf === "shell") return "shell";
  if (leaf === "edit_file" || leaf === "edit") return "edit";
  if (leaf === "write_file" || leaf === "write") return "write";
  if (leaf === "delete" || leaf === "delete_file" || leaf === "unlink" || leaf === "remove_file") return "delete";
  return "other";
}

function actPath(args: Readonly<Record<string, unknown>> | null): string {
  return stringArg(args, "path") || stringArg(args, "file_path");
}

function stringArg(args: Readonly<Record<string, unknown>> | null, key: string): string {
  const value = args?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function outsideRoot(projectPath: string, raw: string): boolean {
  if (projectPath.trim() === "" || raw.trim() === "") return false;
  const shown = workspacePath(projectPath, raw);
  return shown.startsWith("/") || shown.split("/").includes("..");
}

function baseName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") return "a file";
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return name === "" ? "a file" : name;
}

function dirName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (trimmed === "" || trimmed === "." || trimmed === "/" || trimmed === "\\") return "this project";
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return name === "" ? "this project" : name;
}

function walkScript(script: string, depth: number): Seen {
  if (depth > 3) return { sudo: false, phrases: [] };
  let sudo = false;
  const phrases: Phrase[] = [];
  for (const segment of splitSegments(script)) {
    if (segment.startsWith("#")) continue;
    const seen = readCommand(tokenize(segment), depth);
    if (seen.sudo) sudo = true;
    phrases.push(...seen.phrases);
  }
  return { sudo, phrases };
}

/** Index access is typed as `string` here, so the length check is what makes absence visible. */
function tokenAt(tokens: readonly string[], index: number): string | undefined {
  return index < tokens.length ? tokens[index] : undefined;
}

function readCommand(tokens: readonly string[], depth: number): Seen {
  let sudo = false;
  const phrases: Phrase[] = [];
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i] ?? "";
    if (/^[a-z_]\w*=/i.test(raw)) {
      i += 1;
      continue;
    }
    const word = commandName(raw);
    if (WRAPPERS.has(word)) {
      if (word === "sudo") sudo = true;
      i += 1;
      if (word === "sudo") i = skipFlags(tokens, i, new Set(["-u", "-g", "-C", "--user", "--group"]));
      else if (word === "nice") i = skipFlags(tokens, i, new Set(["-n", "--adjustment"]));
      else i = skipFlags(tokens, i, new Set());
      continue;
    }
    const args = tokens.slice(i + 1);
    phrases.push(...phrasesFor(word, args));
    const script = tokenAt(args, 1);
    if (
      (word === "bash" || word === "sh" || word === "zsh" || word === "dash") &&
      args[0] === "-c" &&
      script !== undefined
    ) {
      const nested = walkScript(script, depth + 1);
      if (nested.sudo) sudo = true;
      phrases.push(...nested.phrases);
    }
    break;
  }
  return { sudo, phrases };
}

/** Flags that take a value consume the next token. `--` ends the flags. */
function skipFlags(tokens: readonly string[], start: number, valued: ReadonlySet<string>): number {
  let i = start;
  while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) {
    const flag = tokens[i] ?? "";
    i += 1;
    if (flag === "--") break;
    if (valued.has(flag)) i += 1;
  }
  return i;
}

function phrasesFor(word: string, args: readonly string[]): readonly Phrase[] {
  const flags = flagArgs(args);
  const found: Phrase[] = [];
  if (word === "rm" && flags.some((arg) => arg === "--recursive" || shortFlag(arg, "r") || shortFlag(arg, "R"))) {
    found.push(PHRASE.rm);
  }
  if (word === "dd") found.push(PHRASE.dd);
  if (word === "mkfs" || word.startsWith("mkfs.")) found.push(PHRASE.mkfs);
  if (word === "chmod" && flags.some((arg) => arg === "--recursive" || shortFlag(arg, "R"))) found.push(PHRASE.chmod);
  if (word === "git") {
    const sub = gitSub(flags);
    if (sub?.name === "push" && sub.rest.some((arg) => arg === "--force" || shortFlag(arg, "f")))
      found.push(PHRASE.push);
    if (sub?.name === "reset" && sub.rest.includes("--hard")) found.push(PHRASE.reset);
    if (sub?.name === "clean" && sub.rest.some((arg) => arg === "--force" || shortFlag(arg, "f"))) {
      found.push(PHRASE.clean);
    }
  }
  return found;
}

function gitSub(args: readonly string[]): { readonly name: string; readonly rest: readonly string[] } | null {
  let i = 0;
  while (i < args.length && (args[i] ?? "").startsWith("-")) {
    const flag = args[i] ?? "";
    i += 1;
    if (flag === "--") break;
    if (flag === "-c" || flag === "-C" || flag === "--git-dir" || flag === "--work-tree" || flag === "--namespace") {
      i += 1;
    }
  }
  const name = tokenAt(args, i);
  if (name === undefined || name.startsWith("-")) return null;
  return { name, rest: args.slice(i + 1) };
}

function flagArgs(args: readonly string[]): readonly string[] {
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
}

function shortFlag(arg: string, letter: string): boolean {
  return arg.startsWith("-") && !arg.startsWith("--") && arg.includes(letter);
}

function commandName(token: string): string {
  const cut = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return (cut === -1 ? token : token.slice(cut + 1)).toLowerCase();
}

/** `&&`, `|`, and newlines split a script. Quotes keep a nested command whole. */
function splitSegments(script: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i] ?? "";
    if (quote != null) {
      buf += ch;
      if (ch === quote && script[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    const two = script.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(buf);
      buf = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

function tokenize(segment: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (const ch of segment) {
    if (quote != null) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (buf !== "") out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf !== "") out.push(buf);
  return out;
}
