import { parse, type SchemeValue } from "@here.build/arrival";
import { ProgrammaticJob, periodMsOf, SCHEME_REPL_NAMING, SCHEME_REPL_TOOL_NAME } from "@inhuman.tools/harness-model";
import { emptyExprDoor, isUnterminatedDictLiteral, unterminatedDictDoor } from "@inhuman.tools/substrate/doors";
import { type TopLevelSplice, unwrapTopLevel } from "@inhuman.tools/substrate/unwrap-begin";

import { errorText, fail, sealChunk } from "./evaluate.js";
import type { ProgramHost } from "./host.js";
import { moduleRootOf, programSourceOf, type ProgramSource } from "./source.js";

export type OpenedProgram = {
  readonly forms: readonly SchemeValue[];
  readonly kinds: readonly TopLevelSplice[];
  readonly timeoutMs: number | undefined;
  readonly maxInternalCalls: number | undefined;
  readonly periodMs: number | undefined;
  readonly source: ProgramSource;
  /** Jail root for a one-shot, including `sourcePath`'s directory. */
  readonly moduleRoot: string | undefined;
};

function cappedCalls(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/** Schema already accepted. Seals empty expr, a source without a path, and a program that does not parse. */
export async function openProgram(
  chunk: ProgrammaticJob,
  host: ProgramHost,
  data: {
    readonly expr: string;
    readonly timeoutMs?: number;
    readonly maxInternalCalls?: number;
    readonly period?: string;
  },
  seal = true,
): Promise<OpenedProgram | undefined> {
  const refuse = (result: Parameters<typeof sealChunk>[1]): undefined => {
    if (seal) sealChunk(chunk, result);
    return undefined;
  };
  if (data.expr.trim() === "") {
    return refuse(fail(host.doors.render(emptyExprDoor(SCHEME_REPL_NAMING), SCHEME_REPL_TOOL_NAME)));
  }
  const source = programSourceOf(chunk.args, host.evalProgram === true);
  if (source.source != null && source.sourcePath == null) {
    return refuse(fail("Error: source requires sourcePath"));
  }
  let forms: readonly SchemeValue[];
  let kinds: readonly TopLevelSplice[] = [];
  try {
    const unwrapped = unwrapTopLevel(await parse(data.expr));
    forms = unwrapped.forms;
    kinds = unwrapped.kinds;
  } catch (error) {
    const text = errorText(error);
    if (isUnterminatedDictLiteral(text)) {
      return refuse(fail(host.doors.render(unterminatedDictDoor(), SCHEME_REPL_TOOL_NAME)));
    }
    return refuse(fail(text));
  }
  const periodMs = typeof data.period === "string" ? periodMsOf(data.period) : undefined;
  return {
    forms,
    kinds,
    timeoutMs: data.timeoutMs,
    maxInternalCalls: cappedCalls(data.maxInternalCalls),
    periodMs,
    source,
    moduleRoot: moduleRootOf(source.sourcePath, host.moduleRoot, host.root),
  };
}
