/**
 * A `scheme_repl` whose statements are only host calls is a batch of those
 * calls. The tape shows the calls. Any other statement keeps the batch row,
 * because that row is where the program's own result is read.
 *
 * Statement boundaries match the runner's top-level splice (`begin`, `list`,
 * and `[]`). A `let` or `define` around a call is still one statement and
 * stays in the batch.
 */
import { SCHEME_REPL_TOOL_NAME, type ProgrammaticJob } from "@inhuman.tools/harness-model";
import { observable, runInAction } from "mobx";

/** Keep the program until at least one visible call exists and the async reader settles. */
export function schemeProgramUnwrap(program: ProgrammaticJob, visibleCalls: number): boolean {
  return (
    program.toolName === SCHEME_REPL_TOOL_NAME &&
    visibleCalls > 0 &&
    schemeHostCallsOnly(program.expr, new Set(program.toolCalls.map((tool) => tool.name)))
  );
}

/**
 * Scheme symbols that mint a tape cell under a different job name, plus the
 * builtin host calls. A pack tool is known when its wire name was admitted:
 * that name is not in this set.
 */
const HOST_SYMBOLS = new Set([
  "read_file",
  "list_dir",
  "grep",
  "glob",
  "fff_search",
  "write_file",
  "edit_file",
  "shell",
  "web_search",
  "web_extract",
  "mcp/call",
  "update_metadata",
  "context_recall",
  "bot/send",
  "bot/ask",
  "agent/call",
  "agent/ask",
  "agent/continue",
  "agent/log",
  "agent/message",
  "agent/void",
  "agent/notify",
]);

type SExpr =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "atom"; readonly text: string }
  | { readonly kind: "quote"; readonly inner: SExpr }
  | { readonly kind: "list"; readonly items: readonly SExpr[]; readonly bracket: "(" | "[" | "{" };

const formsOf = observable.map<string, readonly SExpr[] | "error">([], { deep: false });
const pending = new Map<string, Promise<void>>();

export function schemeExprSettled(expr: string): boolean {
  return formsOf.has(expr);
}

export function schemeExprReady(expr: string): Promise<void> {
  if (formsOf.has(expr)) return Promise.resolve();
  const inflight = pending.get(expr);
  if (inflight !== undefined) return inflight;
  const promise = settle(expr).finally(() => {
    pending.delete(expr);
  });
  pending.set(expr, promise);
  return promise;
}

async function settle(expr: string): Promise<void> {
  await Promise.resolve();
  const forms = readForms(expr);
  runInAction(() => {
    formsOf.set(expr, forms ?? "error");
  });
}

export function schemeHostCallsOnly(expr: string, admitted: ReadonlySet<string>): boolean {
  const hit = formsOf.get(expr);
  if (hit === undefined) {
    void schemeExprReady(expr);
    return false;
  }
  if (hit === "error") return false;
  const statements = unwrapTopLevelBegins(hit);
  if (statements.length === 0) return false;
  return statements.every((form) => {
    const name = headSymbol(form);
    return name !== undefined && (HOST_SYMBOLS.has(name) || admitted.has(name));
  });
}

function unwrapTopLevelBegins(forms: readonly SExpr[]): readonly SExpr[] {
  const out: SExpr[] = [];
  const visit = (form: SExpr): void => {
    if (form.kind === "list") {
      if (form.bracket === "[" && !hasDottedPair(form.items)) {
        for (const inner of form.items) visit(inner);
        return;
      }
      if (form.bracket === "(" && form.items.length > 0 && !hasDottedPair(form.items)) {
        const head = form.items[0]!;
        if (head.kind === "atom" && (head.text === "begin" || head.text === "list")) {
          for (const inner of form.items.slice(1)) visit(inner);
          return;
        }
      }
    }
    out.push(form);
  };
  for (const form of forms) visit(form);
  return out;
}

function hasDottedPair(items: readonly SExpr[]): boolean {
  return items.some((item) => item.kind === "atom" && item.text === ".");
}

function headSymbol(form: SExpr): string | undefined {
  if (form.kind !== "list" || form.bracket !== "(" || form.items.length === 0 || hasDottedPair(form.items)) {
    return undefined;
  }
  const head = form.items[0]!;
  if (head.kind !== "atom") return undefined;
  if (head.text.startsWith("#") || head.text.startsWith(":") || /^-?\d+(?:\.\d+)?$/.test(head.text)) {
    return undefined;
  }
  return head.text;
}

function readForms(input: string): readonly SExpr[] | null {
  let pos = 0;
  const len = input.length;

  function skipWs(): void {
    while (pos < len) {
      const ch = input[pos]!;
      if (ch === ";") {
        while (pos < len && input[pos] !== "\n") pos++;
      } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        pos++;
      } else {
        break;
      }
    }
  }

  function readOne(): SExpr | null {
    skipWs();
    if (pos >= len) return null;
    const ch = input[pos]!;
    if (ch === ")" || ch === "]" || ch === "}") return null;
    if (ch === "(" || ch === "[" || ch === "{") {
      const open = ch;
      const close = open === "(" ? ")" : open === "[" ? "]" : "}";
      pos++;
      const items: SExpr[] = [];
      for (;;) {
        skipWs();
        if (pos >= len) return null;
        if (input[pos] === close) {
          pos++;
          return { kind: "list", items, bracket: open };
        }
        if (input[pos] === ")" || input[pos] === "]" || input[pos] === "}") return null;
        const item = readOne();
        if (item === null) return null;
        items.push(item);
      }
    }
    if (ch === "'" || ch === "`" || ch === ",") {
      pos++;
      if (ch === "," && pos < len && input[pos] === "@") pos++;
      const inner = readOne();
      if (inner === null) return null;
      return { kind: "quote", inner };
    }
    if (ch === '"') {
      pos++;
      let out = "";
      while (pos < len) {
        const c = input[pos]!;
        if (c === '"') {
          pos++;
          return { kind: "string", value: out };
        }
        if (c === "\\") {
          pos++;
          if (pos >= len) return null;
          out += input[pos]!;
          pos++;
        } else {
          out += c;
          pos++;
        }
      }
      return null;
    }
    const start = pos;
    while (pos < len) {
      const c = input[pos]!;
      if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === "\r" ||
        c === "(" ||
        c === ")" ||
        c === "[" ||
        c === "]" ||
        c === "{" ||
        c === "}" ||
        c === '"' ||
        c === ";"
      ) {
        break;
      }
      pos++;
    }
    const text = input.slice(start, pos);
    if (text === "") return null;
    return { kind: "atom", text };
  }

  const out: SExpr[] = [];
  for (;;) {
    skipWs();
    if (pos >= len) break;
    const item = readOne();
    if (item === null) return null;
    out.push(item);
  }
  return out;
}
