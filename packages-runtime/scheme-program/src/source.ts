/**
 * Module `require` jail. Eval with `sourcePath` stays under the entry file's
 * directory. Interactive `scheme_repl` / `scheme_watch` jail at the workspace
 * (`host.root`). Skill inputs stay on licensed `read_file`.
 */
import { toJS, type SchemeValue } from "@here.build/arrival";
import { makeFsLoader, type Loader } from "@here.build/arrival-modules";
import type { ProgrammaticJob } from "@inhuman.tools/harness-model";

export type ProgramSource = {
  readonly source?: string;
  readonly sourcePath?: string;
};

export function programSourceOf(raw: unknown, allow: boolean): ProgramSource {
  if (!allow || raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  const source = typeof rec.source === "string" && rec.source !== "" ? rec.source : undefined;
  const sourcePath =
    typeof rec.sourcePath === "string" && rec.sourcePath.trim() !== "" ? rec.sourcePath.trim() : undefined;
  return { source, sourcePath };
}

function parentDir(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash <= 0) return slash === 0 ? path.slice(0, 1) : ".";
  return path.slice(0, slash);
}

export function moduleRootOf(
  sourcePath: string | undefined,
  override?: string,
  workspaceRoot?: string,
): string | undefined {
  if (override != null && override !== "") return override;
  if (sourcePath != null && sourcePath !== "") return parentDir(sourcePath);
  if (workspaceRoot != null && workspaceRoot !== "") return workspaceRoot;
  return undefined;
}

/** Replay read. The live loader records the same key the first time it touches disk. */
export function recordedModuleLoader(job: ProgrammaticJob): Loader {
  return makeFsLoader({
    readFile(key: string) {
      const text = job.modules[key];
      if (text === undefined) throw new Error(`replay: no recorded module ${key}`);
      return text;
    },
  });
}

/** toJS of a dict or list is an egress proxy. structuredClone rejects proxies. */
function plainData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function") throw new Error("not json");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("cycle");
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => plainData(item, seen));
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error("not json");
    out[key] = plainData((value as Record<string, unknown>)[key], seen);
  }
  return out;
}

/** Objects/arrays become the additive `json` sibling. Scalars stay display-only. */
export function structuredJson(value: SchemeValue): { json?: unknown; jsonError?: string } {
  const js = toJS(value);
  if (typeof js === "function") return { jsonError: "value is not JSON-compatible" };
  if (js === null || typeof js !== "object") return {};
  try {
    const cloned: unknown = structuredClone(plainData(js));
    return { json: cloned };
  } catch {
    return { jsonError: "value is not JSON-compatible" };
  }
}
