/**
 * Tool-name cluster table. Catalog class-stamp is later. Unknown and MCP
 * share the mcp residual seat — auto still starts a judge and retries.
 * `scheme_repl` is a ProgrammaticJob bag, not a leaf; do not license it
 * through this table. Inner System/MCP/agent calls keep their clusters.
 */

export type Cluster = "bash" | "read" | "write" | "mcp";

export function clusterOf(name: string): Cluster {
  switch (name) {
    case "shell":
      return "bash";
    case "read_file":
    case "list_dir":
    case "grep":
    case "glob":
    case "fff_search":
      return "read";
    case "write_file":
    case "edit_file":
      return "write";
    default:
      return "mcp";
  }
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Tools whose input schema genuinely carries a `cwd` directory key (read as `cwd`, then `path`). */
const CWD_TOOLS: ReadonlySet<string> = new Set(["glob", "fff_search"]);

/**
 * File-access question: the path the tool will actually open. Only tools whose
 * schema has a `cwd` key (glob / fff_search) consult it; every other file tool
 * strips unknown keys, so a decoy `cwd` must never stand in for `path`.
 * Missing is null, not `"."` — read callers default, write callers leave ask.
 */
export function fileQuestion(name: string, args: Readonly<Record<string, unknown>> | null | undefined): string | null {
  if (args == null) return null;
  if (CWD_TOOLS.has(name)) return nonemptyString(args.cwd) ?? nonemptyString(args.path);
  return nonemptyString(args.path);
}
