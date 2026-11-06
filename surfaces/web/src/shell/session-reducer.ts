import type { TapeBodyCell, TapeCell } from "./tape-read.js";

/** Facts from the tape, not guesses made from rendered tool output. */
export type FileFact =
  | { readonly kind: "read"; readonly path: string; readonly content: string }
  | {
      readonly kind: "mutation";
      readonly path: string;
      readonly status: "applied" | "pending" | "failed";
      readonly prior: string | null;
      readonly existed: boolean | null;
      readonly receipt?: string;
      readonly lineStart?: number;
      readonly operation:
        | { readonly kind: "write"; readonly content: string }
        | { readonly kind: "edit"; readonly oldText: string; readonly newText: string; readonly replaceAll: boolean };
    };

export type SessionEvent = TapeCell | { readonly kind: "turn"; readonly id: string };

type Chain = {
  readonly id: string;
  readonly before: string;
  readonly mutationIds: readonly string[];
  readonly roundIds: readonly string[];
  readonly index: number;
  readonly nestedIndex: number | null;
};
type FileState = { content: string | null; chain?: Chain | undefined };

/** Replay the current snapshot. Pending jobs can settle or gain facts in place. */
export function reduceSession(events: readonly SessionEvent[], projectPath: string): TapeCell[] {
  return reduceInto(events, projectPath, new Map());
}

function reduceInto(
  events: readonly SessionEvent[],
  projectPath: string,
  files: Map<string, FileState>,
  cells: (TapeCell | null)[] = [],
): TapeCell[] {
  let roundId = "";
  for (const event of events) {
    if (event.kind === "turn" || event.kind === "user") {
      // Never silently rewrite the diff belonging to a previous user request.
      files.clear();
      roundId = "";
      if (event.kind === "user") cells.push(event);
      continue;
    }
    if (event.kind === "round") roundId = event.id;
    if (event.kind === "tool" && event.nested != null) {
      const start = cells.length;
      reduceInto(event.nested, projectPath, files, cells);
      const produced = cells.splice(start).filter((cell): cell is TapeCell => cell != null && cell.kind !== "progress");
      const nested = produced.filter((cell): cell is TapeBodyCell => cell.kind !== "round");
      const placed = cells.length;
      cells.push({ ...event, nested });
      retarget(files, start, placed, nested);
      continue;
    }
    if (event.kind !== "tool" || event.file == null) {
      cells.push(event);
      continue;
    }
    const fact = event.file;
    const key = fileKey(projectPath, fact.path);
    const state = files.get(key);
    if (fact.kind === "read") {
      // A read may reveal an external change. Only preceding full reads count.
      files.set(key, {
        content: fact.content,
        chain: state?.content === fact.content ? state.chain : undefined,
      });
      cells.push(event);
      continue;
    }
    if (fact.status !== "applied") {
      cells.push(event);
      continue;
    }
    const before = fact.prior ?? (fact.existed === false ? "" : (state?.content ?? null));
    const after = applyMutation(fact.operation, before);
    if (before == null || after == null) {
      // A whole-file write establishes the next baseline even without its old
      // bytes. A partial edit without a baseline cannot establish a whole file.
      files.set(key, { content: fact.operation.kind === "write" ? fact.operation.content : null });
      // Never keep a full-file diff that an independent receipt may have
      // reconstructed from stale reads, or an invented empty-old creation.
      cells.push({
        ...event,
        body:
          fact.operation.kind === "edit" && fact.operation.oldText !== ""
            ? {
                kind: "diff",
                path: fact.path,
                oldText: fact.operation.oldText,
                newText: fact.operation.newText,
                lineStart: fact.lineStart,
              }
            : {
                kind: "text",
                text:
                  fact.receipt == null || fact.receipt === ""
                    ? "File updated; previous content unavailable."
                    : fact.receipt,
              },
      });
      continue;
    }
    const previous = state?.content === before ? state.chain : undefined;
    if (previous != null) clearChain(cells, previous);
    const chain: Chain = {
      id: previous?.id ?? event.id,
      before: previous?.before ?? before,
      mutationIds: [...(previous?.mutationIds ?? []), event.id],
      roundIds: [...new Set([...(previous?.roundIds ?? []), roundId])],
      index: cells.length,
      nestedIndex: null,
    };
    // The net diff lives at the latest contributing edit, not in an earlier
    // round that had not produced the final content yet. Keep a stable identity.
    cells.push({
      ...event,
      id: chain.id,
      body: { kind: "diff", path: fact.path, oldText: chain.before, newText: after },
      edits: { mutationIds: chain.mutationIds, roundIds: chain.roundIds },
    });
    files.set(key, { content: after, chain });
  }
  return cells.filter((cell): cell is TapeCell => cell != null);
}

function retarget(files: Map<string, FileState>, start: number, placed: number, nested: readonly TapeCell[]): void {
  for (const state of files.values()) {
    const chain = state.chain;
    if (chain == null || chain.index < start) continue;
    const at = chain.index - start;
    if (at < 0 || at >= nested.length) continue;
    state.chain = { ...chain, index: placed, nestedIndex: at };
  }
}

function clearChain(cells: (TapeCell | null)[], chain: Chain): void {
  const cell = cells[chain.index];
  if (cell == null) return;
  if (chain.nestedIndex == null) {
    cells[chain.index] = null;
    return;
  }
  if (cell.kind !== "tool" || cell.nested == null) return;
  const nested = cell.nested.filter((_, at) => at !== chain.nestedIndex);
  cells[chain.index] = { ...cell, nested };
}

function applyMutation(
  operation: Extract<FileFact, { kind: "mutation" }>["operation"],
  before: string | null,
): string | null {
  if (operation.kind === "write") return operation.content;
  if (before == null || operation.oldText === "") return null;
  const at = before.indexOf(operation.oldText);
  if (at === -1) return null;
  if (operation.replaceAll) return before.split(operation.oldText).join(operation.newText);
  // A successful exact edit should be unique. Don't fabricate history when
  // incomplete facts disagree with native edit semantics.
  if (before.includes(operation.oldText, at + operation.oldText.length)) return null;
  return before.slice(0, at) + operation.newText + before.slice(at + operation.oldText.length);
}

/** Lexical identity only: no filesystem reads, case folding, or symlink guesses. */
function fileKey(projectPath: string, path: string): string {
  const source = path.startsWith("/") ? path : `${projectPath}/${path}`;
  const parts: string[] = [];
  for (const part of source.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
