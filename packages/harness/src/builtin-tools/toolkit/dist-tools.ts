/**
 * Toolkit FS tools as InhumanTool definitions and effect bodies.
 * Catalog does not import this package; composition registers the roster.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile as readFileBytes,
  realpath,
  rename,
  stat,
  unlink,
  writeFile as writeFileBytes,
} from "node:fs/promises";
import path from "node:path";

import { optionalDescription } from "@inhuman.tools/harness-model/schemas";
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { extraRootAllowed, ToolError } from "@inhuman.tools/turn/tool-runtime";
import dedent from "dedent";
import { z } from "zod";

import { errnoCode } from "../errno.js";
import { namedBotsHome } from "../named-bots-home.js";
import { MAX_FILE_READ_BYTES, MAX_FILE_WRITE_BYTES } from "./bounds.js";
import { finderFor } from "./finder.js";
import { overwriteExistingDoor, overwriteExistingOf, priorTextSync } from "./write-gate.js";
import { toolResultSchema, toolResultShape } from "../schemas/tool-result.js";

export { ToolError } from "@inhuman.tools/turn/tool-runtime";

type DistContext = {
  readonly root: string;
  readonly signal?: AbortSignal;
  /** write_file / edit_file: host snapshot of prior text (null = binary / too large / missing). */
  readonly onPriorContent?: (text: string | null) => void;
};

export interface ToolResult {
  readonly ok: boolean;
  /** Door / dist string payload. Structured results use `value`; paint is squeeze. */
  readonly text?: string;
  readonly value?: unknown;
  /** Listing/search hit more results than it returned. Markers stay out of `value`. */
  readonly truncated?: boolean;
}

export function asToolResult(out: unknown): ToolResult {
  const parsed = toolResultShape.safeParse(out);
  if (!parsed.success) return { ok: true, value: out };
  return {
    ok: parsed.data.ok,
    ...(typeof parsed.data.text === "string" ? { text: parsed.data.text } : {}),
    ...(out !== null && typeof out === "object" && "value" in out ? { value: parsed.data.value } : {}),
    ...(parsed.data.truncated === true ? { truncated: true } : {}),
  };
}

function optionalString(description: string) {
  return z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().optional().describe(description),
  );
}

function optionalInt(description: string, minimum: number) {
  return z.number().int().min(minimum).optional().describe(description);
}

function optionalBool(description: string) {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, z.boolean().optional().describe(description));
}

const readFileInput = z.object({
  path: z.string().describe("File path, relative to the project root."),
  offset: optionalInt("First line to return, 1-based.", 1),
  limit: optionalInt("How many lines to return from offset.", 1),
});
const listDirInput = z.object({
  path: z.string().describe("Directory path, relative to the project root. Use '.' for the root."),
  depth: optionalInt("How many levels to descend. Defaults to 1.", 1),
});
const grepInput = z.object({
  pattern: z.string().describe("Text, regex, or fuzzy query depending on mode."),
  path: optionalString("Directory or file to search. Defaults to the project root."),
  glob: optionalString("Only search paths matching this glob, e.g. '*.ts' or 'src/**/*.ts'."),
  mode: optionalString("plain (default), regex, or fuzzy."),
  limit: optionalInt("Maximum matches to return. Defaults to 50.", 1),
  before: optionalInt("Context lines before each match.", 0),
  after: optionalInt("Context lines after each match.", 0),
});
const globInput = z.object({
  pattern: z.string().describe("Glob, e.g. '**/*.ts' or 'src/**/*.json'."),
  cwd: optionalString("Directory to search, relative to the project root. Defaults to the project root."),
  path: optionalString("Alias of cwd."),
  limit: optionalInt("Maximum paths to return. Defaults to 500.", 1),
});
const fffSearchInput = z.object({
  query: z.string().describe("Filename or path fragments. Spaces AND. 'src/' scopes to a directory."),
  cwd: optionalString("Directory to search, relative to the project root. Defaults to the project root."),
  path: optionalString("Alias of cwd."),
  limit: optionalInt("Maximum matches. Defaults to 40.", 1),
});
const writeFileInput = z.object({
  path: z.string().describe("File path, relative to the project root."),
  content: z.string().describe("The file's complete new contents."),
  overwriteExisting: optionalBool(
    "Set true to replace an existing file. Omit or false when the path must be new — a write to an existing path fails and names this flag.",
  ),
  description: optionalDescription("file"),
});
const editFileInput = z.object({
  path: z.string().describe("File path, relative to the project root."),
  old_string: z
    .string()
    .describe(
      "The exact text to replace, including whitespace. Must not be empty — use write_file to create or replace a whole file.",
    ),
  new_string: z.string().describe("The replacement text. Empty deletes the old text."),
  replace_all: optionalBool("Replace every occurrence instead of failing when the old text is not unique."),
  description: optionalDescription("file"),
});

type ReadFileInput = z.infer<typeof readFileInput>;
type ListDirInput = z.infer<typeof listDirInput>;
type GrepInput = z.infer<typeof grepInput>;
type GlobInput = z.infer<typeof globInput>;
type FffSearchInput = z.infer<typeof fffSearchInput>;
type WriteFileInput = z.infer<typeof writeFileInput>;
type EditFileInput = z.infer<typeof editFileInput>;

function requireRoot(ctx: { readonly root?: string }): string {
  const root = ctx.root;
  if (root == null || root === "") throw new TypeError("ctx.root string required");
  return root;
}

const LIST_MAX_ENTRIES = 500;
const GREP_MAX_MATCHES = 50;
const GREP_MAX_MS = 2000;
const GLOB_MAX_MATCHES = 500;
const FFF_SEARCH_MAX = 40;

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

const escapeDoor = (
  candidate: string,
  root: string,
  reason: string = `${candidate} resolves outside ${root}`,
): string => dedent`
    path escapes the project root: ${reason}
    Why: file tools stay inside the workspace unless this path was granted for the session.
    Use a path inside the workspace, or shell when the command itself is allowed to run outside it.`;

async function realpathOrLexical(resolved: string): Promise<string> {
  try {
    return await realpath(resolved);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return resolved;
    throw error;
  }
}

/** Lexical `..` collapse + realpath re-check (symlink escape). Extra-root only when licensed. */
export async function resolveInRoot(root: string, candidate: string): Promise<string> {
  const resolved = path.resolve(root, candidate);
  if (!contains(root, resolved)) {
    ToolError.invariant(namedBotsAllowed(resolved) || extraRootAllowed(), escapeDoor(candidate, root));
    return realpathOrLexical(resolved);
  }
  try {
    const real = await realpath(resolved);
    ToolError.invariant(
      contains(root, real),
      escapeDoor(candidate, root, `${candidate} is a link to ${real}, outside ${root}`),
    );
    return real;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (errnoCode(error) === "ENOENT") return resolved;
    throw error;
  }
}

function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function namedBotsAllowed(resolved: string): boolean {
  const home = namedBotsHome();
  return home != null && contains(home, resolved);
}

/**
 * Write path resolve: climb to deepest existing ancestor, realpath that, re-join
 * remainder (leaf may not exist yet — resolveInRoot ENOENT lexical path is unsafe for writes).
 */
export async function resolveWriteTarget(root: string, candidate: string): Promise<{ target: string; parent: string }> {
  const resolved = path.resolve(root, candidate);
  const lexicalIn = contains(root, resolved);
  ToolError.invariant(lexicalIn || namedBotsAllowed(resolved) || extraRootAllowed(), escapeDoor(candidate, root));
  ToolError.invariant(resolved !== root, `${candidate} is the project root itself, not a file`);

  const trailing: string[] = [];
  let existing = path.dirname(resolved);
  for (;;) {
    try {
      const real = await realpath(existing);
      ToolError.invariant(
        !lexicalIn || contains(root, real),
        escapeDoor(candidate, root, `${candidate} is under ${existing}, a link to ${real} outside ${root}`),
      );
      const parent = path.join(real, ...trailing);
      const leaf = path.join(parent, path.basename(resolved));
      return { target: await resolveLeafLink(root, candidate, leaf, lexicalIn), parent };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (errnoCode(error) !== "ENOENT") throw error;
      trailing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

/**
 * A leaf that is a symlink is followed by writeFile, so the ancestor check above is not enough.
 * Resolve it and hold the real file to the same rule as the parent; a dangling link is refused
 * because writing through it would create a file wherever it points.
 */
async function resolveLeafLink(root: string, candidate: string, leaf: string, lexicalIn: boolean): Promise<string> {
  let info: Stats;
  try {
    info = await lstat(leaf);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return leaf;
    throw error;
  }
  if (!info.isSymbolicLink()) return leaf;
  let real: string;
  try {
    real = await realpath(leaf);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new ToolError(`${candidate} is a dangling symlink — refusing to write through it`);
    }
    throw error;
  }
  ToolError.invariant(
    lexicalIn ? contains(root, real) : namedBotsAllowed(real) || extraRootAllowed(),
    escapeDoor(candidate, root, `${candidate} is a link to ${real}, outside ${root}`),
  );
  return real;
}

async function readFileTool(args: ReadFileInput, context: DistContext): Promise<ToolResult> {
  const target = await resolveInRoot(context.root, args.path);
  const info = await statOrDoor(target, args.path);
  if (info.isDirectory()) {
    return {
      ok: false,
      text: `${args.path} is a directory — use list_dir to see what is in it`,
    };
  }

  const handle = await open(target, fsConstants.O_RDONLY);
  let raw: string;
  let clipped = false;
  try {
    const budget = Math.min(info.size, MAX_FILE_READ_BYTES);
    const buffer = Buffer.allocUnsafe(budget);
    const { bytesRead } = await handle.read(buffer, 0, budget, 0);
    raw = buffer.subarray(0, bytesRead).toString("utf8");
    clipped = info.size > budget;
  } finally {
    await handle.close();
  }

  const offset = args.offset;
  const limit = args.limit;
  let body = raw;
  if (offset !== undefined || limit !== undefined) {
    const lines = raw.split("\n");
    const from = (offset ?? 1) - 1;
    body = lines.slice(from, limit === undefined ? undefined : from + limit).join("\n");
  }
  if (clipped) body += `\n…[file is ${info.size} bytes; read the first ${MAX_FILE_READ_BYTES}]`;
  return { ok: true, text: body };
}

async function listDirTool(args: ListDirInput, context: DistContext): Promise<ToolResult> {
  const target = await resolveInRoot(context.root, args.path);
  const info = await statOrDoor(target, args.path);
  if (!info.isDirectory())
    return {
      ok: false,
      text: `${args.path} is not a directory — use read_file for a file`,
    };

  const depth = args.depth ?? 1;
  const entries: string[] = [];
  let capped = false;
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth || capped) return;
    const listing = await readdir(dir, { withFileTypes: true });
    for (const entry of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= LIST_MAX_ENTRIES) {
        capped = true;
        return;
      }
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(context.root, absolute) || ".";
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        if (!SKIPPED_DIRS.has(entry.name)) await walk(absolute, level + 1);
      } else {
        entries.push(relative);
      }
    }
  };
  await walk(target, 1);

  if (entries.length === 0) return { ok: true, value: [], text: `(empty directory: ${args.path})` };
  const marker = capped ? `…[listing capped at ${LIST_MAX_ENTRIES} entries]` : "";
  return {
    ok: true,
    value: entries,
    truncated: capped,
    text: marker === "" ? entries.join("\n") : `${entries.join("\n")}\n${marker}`,
  };
}

function posixRel(root: string, absolute: string): string {
  return (path.relative(root, absolute) || ".").split(path.sep).join("/");
}

async function workspaceFinder(context: DistContext) {
  try {
    return await finderFor(context.root, context.signal);
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : String(error));
  }
}

/** fff grep query. Directory prefixes get a trailing slash; file paths do not. */
export function constrainQuery(
  pattern: string,
  pathRel: string | undefined,
  glob: string | undefined,
  directory = true,
): string {
  const parts: string[] = [];
  if (glob !== undefined && glob !== "") parts.push(glob);
  if (pathRel !== undefined && pathRel !== "" && pathRel !== ".") {
    parts.push(!directory || pathRel.endsWith("/") ? pathRel : `${pathRel}/`);
  }
  parts.push(pattern);
  return parts.join(" ");
}

function globUnder(pattern: string, pathRel: string | undefined): string {
  if (pathRel === undefined || pathRel === "" || pathRel === ".") return pattern;
  const prefix = pathRel.replace(/\/$/, "");
  if (pattern.startsWith(`${prefix}/`) || pattern.startsWith(`${prefix}\\`)) return pattern;
  return `${prefix}/${pattern}`;
}

function searchCwd(args: { readonly cwd?: string; readonly path?: string }): string {
  for (const key of ["cwd", "path"] as const) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return ".";
}

async function globTool(args: GlobInput, context: DistContext): Promise<ToolResult> {
  const pattern = args.pattern;
  if (pattern === "") {
    return { ok: false, text: `glob: "pattern" must not be empty — call glob again with a pattern like "**/*.ts"` };
  }
  const asWritten = searchCwd(args);
  const start = await resolveInRoot(context.root, asWritten);
  const info = await statOrDoor(start, asWritten);
  const pathRel = posixRel(context.root, start);
  if (!info.isDirectory() && pathRel !== ".") {
    return {
      ok: false,
      text: `${asWritten} is not a directory — use read_file for a file`,
    };
  }
  const finder = await workspaceFinder(context);
  const pageSize = args.limit ?? GLOB_MAX_MATCHES;
  const found = finder.glob(globUnder(pattern, info.isDirectory() ? pathRel : undefined), { pageSize });
  if (!found.ok) return { ok: false, text: `glob: ${found.error}` };
  const paths = found.value.items.map((item) => item.relativePath.split(path.sep).join("/"));
  if (paths.length === 0) return { ok: true, value: [], text: `(no files match ${pattern})` };
  const more =
    found.value.totalMatched > paths.length ? `…[${found.value.totalMatched} total; showing ${paths.length}]` : "";
  return {
    ok: true,
    value: paths,
    truncated: found.value.totalMatched > paths.length,
    text: more === "" ? paths.join("\n") : `${paths.join("\n")}\n${more}`,
  };
}

async function grepTool(args: GrepInput, context: DistContext): Promise<ToolResult> {
  const pattern = args.pattern;
  const modeRaw = args.mode ?? "plain";
  const mode = modeRaw.trim().toLowerCase();
  if (mode !== "plain" && mode !== "regex" && mode !== "fuzzy") {
    return {
      ok: false,
      text: `grep: "mode" must be plain, regex, or fuzzy, got ${modeRaw} — call grep again with one of those`,
    };
  }
  const asWritten = args.path ?? ".";
  const start = await resolveInRoot(context.root, asWritten);
  const info = await statOrDoor(start, asWritten);
  const pathRel = posixRel(context.root, start);
  const finder = await workspaceFinder(context);
  const glob = args.glob;
  // A file path must stay a file. `constrainQuery` slash-suffixes directory
  // prefixes (`src/` → files under src). Suffixing `admission.ts/` matches
  // nothing — the agent then sees Scheme `'()` printed as `nil`.
  const query = constrainQuery(
    pattern,
    pathRel === "." ? undefined : pathRel,
    glob,
    info.isDirectory() || pathRel === ".",
  );
  const pageSize = args.limit ?? GREP_MAX_MATCHES;
  const result = finder.grep(query, {
    mode,
    pageSize,
    timeBudgetMs: GREP_MAX_MS,
    beforeContext: args.before,
    afterContext: args.after,
  });
  if (!result.ok) return { ok: false, text: `grep: ${result.error}` };
  if (mode === "regex" && result.value.regexFallbackError !== undefined) {
    return {
      ok: false,
      text: `grep: "pattern" is not a valid regular expression — ${result.value.regexFallbackError}`,
    };
  }
  if (result.value.items.length === 0) {
    return { ok: true, value: [], text: `(no matches for /${pattern}/)` };
  }
  const lines = result.value.items.map((match) => {
    const rel = match.relativePath.split(path.sep).join("/");
    return `${rel}:${match.lineNumber}: ${match.lineContent.trim()}`;
  });
  const truncated = result.value.nextCursor !== null;
  const extra = truncated ? `…[more matches; raise limit (now ${pageSize}) or narrow glob/path]` : "";
  return {
    ok: true,
    value: lines,
    truncated,
    text: extra === "" ? lines.join("\n") : `${lines.join("\n")}\n${extra}`,
  };
}

async function fffSearchTool(args: FffSearchInput, context: DistContext): Promise<ToolResult> {
  const query = args.query;
  if (query.trim() === "") {
    return {
      ok: false,
      text: `fff_search: "query" must not be empty — call fff_search again with the file name you are looking for`,
    };
  }
  const asWritten = searchCwd(args);
  const start = await resolveInRoot(context.root, asWritten);
  const info = await statOrDoor(start, asWritten);
  if (!info.isDirectory()) return { ok: false, text: `${asWritten} is not a directory — use read_file for a file` };
  const pathRel = posixRel(context.root, start);
  const finder = await workspaceFinder(context);
  const scoped = pathRel === "." ? query.trim() : `${pathRel}/ ${query.trim()}`;
  const pageSize = args.limit ?? FFF_SEARCH_MAX;
  const found = finder.fileSearch(scoped, { pageSize });
  if (!found.ok) return { ok: false, text: `fff_search: ${found.error}` };
  if (found.value.items.length === 0) return { ok: true, value: [], text: `(no files match ${query})` };
  const lines = found.value.items.map((item) => item.relativePath.split(path.sep).join("/"));
  return { ok: true, value: lines, text: lines.join("\n") };
}

/** Existing files keep their inode (`O_TRUNC`). Missing files spawn. */
async function writeFileTool(args: WriteFileInput, context: DistContext): Promise<ToolResult> {
  const asWritten = args.path;
  const content = args.content;
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_WRITE_BYTES) {
    return {
      ok: false,
      text: `write_file: content is ${size} bytes, over the ${MAX_FILE_WRITE_BYTES}-byte limit — write it in pieces with edit_file`,
    };
  }

  const { target, parent } = await resolveWriteTarget(context.root, asWritten);
  return withFsLock(target, async () => {
    const existing = await statOrNull(target);
    if (existing?.isDirectory() === true) return { ok: false, text: `${asWritten} is a directory, not a file` };

    const rel = path.relative(context.root, target).split(path.sep).join("/") || asWritten;

    if (existing === null) {
      context.onPriorContent?.(null);
      await mkdir(parent, { recursive: true });
      try {
        await writeFileBytes(target, content, "utf8");
      } catch (error) {
        throw new ToolError(`could not write ${asWritten}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { ok: true, text: `created ${rel} (${size} bytes)` };
    }

    const prior = priorTextSync(target);
    context.onPriorContent?.(prior);
    if (!overwriteExistingOf(args)) {
      return { ok: false, text: overwriteExistingDoor(asWritten) };
    }

    try {
      await writeFileBytes(target, content, "utf8");
    } catch (error) {
      throw new ToolError(`could not write ${asWritten}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: true, text: `replaced ${rel} (${size} bytes)` };
  });
}

/**
 * Re-read at apply time (not confirmation) so a stale edit fails the match as a door.
 * Every refusal names a count or boundary (unnamed "edit failed" causes identical retries).
 */
async function editFileTool(args: EditFileInput, context: DistContext): Promise<ToolResult> {
  const asWritten = args.path;
  const oldString = args.old_string;
  const newString = args.new_string;
  const replaceAll = args.replace_all === true;

  if (oldString === "") {
    return {
      ok: false,
      text: `edit_file: "old_string" must not be empty — use write_file to create ${asWritten} or replace all of it`,
    };
  }
  if (oldString === newString) {
    return {
      ok: false,
      text: `edit_file: "old_string" and "new_string" are identical — the edit would change nothing`,
    };
  }

  const { target } = await resolveWriteTarget(context.root, asWritten);
  return withFsLock(target, async () => {
    const info = await statOrNull(target);
    if (info === null)
      return {
        ok: false,
        text: `no such file under the project root: ${asWritten} — use write_file to create it`,
      };
    if (info.isDirectory()) return { ok: false, text: `${asWritten} is a directory, not a file` };
    if (info.size > MAX_FILE_READ_BYTES)
      return {
        ok: false,
        text: `edit_file: ${asWritten} is ${info.size} bytes, too large to edit in place`,
      };

    const before = await readFileBytes(target, "utf8");
    context.onPriorContent?.(before);
    const occurrences = before.split(oldString).length - 1;
    if (occurrences === 0) {
      return {
        ok: false,
        text: `edit_file: that exact text does not appear in ${asWritten}. The file may have changed since you read it — read it again and quote the current text, including whitespace.`,
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        text: `edit_file: that text appears ${occurrences} times in ${asWritten}. Include more surrounding lines to make it unique, or pass replace_all=true to change all ${occurrences}.`,
      };
    }

    const after = replaceSpan(before, oldString, newString, replaceAll);
    const size = Buffer.byteLength(after, "utf8");
    if (size > MAX_FILE_WRITE_BYTES) {
      return {
        ok: false,
        text: `edit_file: the result would be ${size} bytes, over the ${MAX_FILE_WRITE_BYTES}-byte limit`,
      };
    }

    const scratch = `${target}.harness-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFileBytes(scratch, after, "utf8");
      await rename(scratch, target);
    } catch (error) {
      await unlink(scratch).catch(() => undefined);
      throw new ToolError(`could not write ${asWritten}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const relative = path.relative(context.root, target) || asWritten;
    return {
      ok: true,
      text: `edited ${relative} (${occurrences} replacement${occurrences === 1 ? "" : "s"}, ${size} bytes)`,
    };
  });
}

/** Literal insert. String.replace treats $ in new_string as a substitution pattern. */
function replaceSpan(haystack: string, needle: string, replacement: string, all: boolean): string {
  if (all) return haystack.split(needle).join(replacement);
  const at = haystack.indexOf(needle);
  return at === -1 ? haystack : haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

/** Serialize write_file / edit_file on one resolved path so unique spans in one turn both land. ponytail: in-process only; flock if two daemons share a tree. */
const fsLocks = new Map<string, Promise<void>>();

function withFsLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const prev = fsLocks.get(target) ?? Promise.resolve();
  const run = prev.then(fn);
  const done = run.then(
    () => undefined,
    () => undefined,
  );
  fsLocks.set(target, done);
  void done.then(() => {
    if (fsLocks.get(target) === done) fsLocks.delete(target);
    return undefined;
  });
  return run;
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    ToolError.invariant(errnoCode(error) !== "EACCES", `permission denied at ${target}`);
    throw error;
  }
}

async function statOrDoor(target: string, asWritten: string): Promise<Stats> {
  try {
    return await stat(target);
  } catch (error) {
    ToolError.invariant(errnoCode(error) !== "ENOENT", `no such path under the project root: ${asWritten}`);
    ToolError.invariant(errnoCode(error) !== "EACCES", `permission denied reading ${asWritten}`);
    throw error;
  }
}

export const readFile = new InhumanTool({
  name: "read_file",
  description: "Read a UTF-8 text file under the project root.",
  class: "read",
  representation: "symbol",
  input: readFileInput,
  output: toolResultSchema,
  run: (input, ctx) => readFileTool(input, { root: requireRoot(ctx), signal: ctx.signal }),
});

export const listDir = new InhumanTool({
  name: "list_dir",
  description: "List the entries of a directory under the project root. Directories end with '/'.",
  class: "read",
  representation: "symbol",
  input: listDirInput,
  output: toolResultSchema,
  run: (input, ctx) => listDirTool(input, { root: requireRoot(ctx), signal: ctx.signal }),
});

export const grep = new InhumanTool({
  name: "grep",
  description:
    "Search file contents under the project root (indexed). mode is plain (literal, default), regex, or fuzzy. glob/path constrain which files are opened. before/after add context lines.",
  class: "read",
  representation: "symbol",
  input: grepInput,
  output: toolResultSchema,
  run: (input, ctx) => grepTool(input, { root: requireRoot(ctx), signal: ctx.signal }),
});

export const glob = new InhumanTool({
  name: "glob",
  description:
    "Find files under the project root whose paths match a glob pattern (exact glob, not fuzzy). Use fff_search to find files by name/intent; use grep to search inside files.",
  class: "read",
  representation: "symbol",
  input: globInput,
  output: toolResultSchema,
  run: (input, ctx) => globTool(input, { root: requireRoot(ctx), signal: ctx.signal }),
});

export const fffSearch = new InhumanTool({
  name: "fff_search",
  description:
    "Fuzzy file search under the project root (typo-resistant, frecency-ranked). Use glob for exact patterns like **/*.ts.",
  class: "read",
  representation: "symbol",
  input: fffSearchInput,
  output: toolResultSchema,
  run: (input, ctx) => fffSearchTool(input, { root: requireRoot(ctx), signal: ctx.signal }),
});

function onPriorContentOf(ctx: { readonly [key: string]: unknown }): ((text: string | null) => void) | undefined {
  const fn = ctx.onPriorContent;
  return typeof fn === "function" ? (fn as (text: string | null) => void) : undefined;
}

export const writeFile = new InhumanTool({
  name: "write_file",
  description:
    "Create a file under the project root, or replace one entirely. Replacing an existing file requires overwriteExisting. Requires the user's confirmation. To change part of a file, use edit_file.",
  class: "write",
  representation: "both",
  input: writeFileInput,
  output: toolResultSchema,
  run: (input, ctx) =>
    writeFileTool(input, {
      root: requireRoot(ctx),
      signal: ctx.signal,
      onPriorContent: onPriorContentOf(ctx),
    }),
});

export const editFile = new InhumanTool({
  name: "edit_file",
  description:
    "Replace an exact stretch of text in an existing file. Requires the user's confirmation. The old text must appear exactly once unless replace_all is true.",
  class: "write",
  representation: "both",
  input: editFileInput,
  output: toolResultSchema,
  run: (input, ctx) =>
    editFileTool(input, {
      root: requireRoot(ctx),
      signal: ctx.signal,
      onPriorContent: onPriorContentOf(ctx),
    }),
});

export const DIST_TOOLS = [readFile, listDir, grep, glob, fffSearch, writeFile, editFile] as const;
