/**
 * A `scheme_repl` whose statements are only host calls is a batch of those
 * calls. The tape shows the calls. Any other statement keeps the batch row,
 * because that row is where the program's own result is read.
 *
 * Arrival's `parse` is async (`reader/parse.ts`), and the tape computed
 * cannot await it. The decision stays false until the reader settles, then
 * the map write wakes the computed. A batch with no admitted call yet stays
 * a row, so a reader error or a program that has not minted a call is not
 * a blank gap.
 *
 * Statement boundaries are the runner's, not the raw reader list.
 * `unwrapTopLevelBegins` splices top-level `begin`, `list`, and `[]`
 * (`packages-runtime/substrate/src/unwrap-begin.ts`). A `let` or `define`
 * around a call is still one statement and stays in the batch.
 */
import { parse, type SchemeValue } from "@here.build/arrival";
import { APair, ASymbol } from "@here.build/arrival/reflect-internals";
import { unwrapTopLevelBegins } from "@inhuman.tools/substrate/unwrap-begin";
import { observable, runInAction } from "mobx";

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
  "bot/send",
  "bot/ask",
  "agent/call",
  "agent/ask",
  "agent/message",
  "agent/void",
  "agent/notify",
]);

const formsOf = observable.map<string, readonly SchemeValue[] | "error">([], { deep: false });
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
  try {
    const forms = await parse(expr);
    runInAction(() => {
      formsOf.set(expr, forms);
    });
  } catch {
    runInAction(() => {
      formsOf.set(expr, "error");
    });
  }
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

function headSymbol(form: SchemeValue): string | undefined {
  if (!(form instanceof APair)) return undefined;
  const head = form.car;
  if (!(head instanceof ASymbol)) return undefined;
  const name = head.valueOf();
  return typeof name === "string" ? name : undefined;
}
