/**
 * Compact is the unique well-known session action. Obligatory.
 * Calculations (floors, occupancy, reject, zones) live in harness-context.
 * `applyCompact` is the executing actor in this package.
 *
 * `loadCompactProgram` reads a strategy path through an optional resolve
 * host. Composition supplies package defaults, and the shipped default is a
 * real strategy (a model-written state snapshot, `compact.scm` +
 * `compact.prompt` in the harness package). The inline keep-first program is
 * a FAILSAFE, nothing more: it runs only when the configured program and the
 * shipped default are both missing or unreadable, so that a compact never
 * has nothing to run. It is not a strategy. A program that is returned with
 * `failsafe` set tells the caller to log a diagnostic.
 */

const INLINE_KEEP_FIRST =
  "(define (compact compact-transcript full-transcript) (let ((xs (transcript/cells compact-transcript))) (if (null? xs) xs (list (car xs)))))";

export type CompactProgram = {
  readonly source: string;
  /**
   * Absolute path the source was read from. `require` (`.prompt` pretreats) is
   * jailed under its dirname; absent for the inline fallback and a dist stub
   * that has no `compact.prompt` next to it.
   */
  readonly sourcePath: string | null;
  /**
   * Set only on the inline keep-first failsafe: why no real program could be
   * loaded. The caller must surface it; a silent failsafe would hide a broken
   * install behind a compaction that drops almost everything.
   */
  readonly failsafe?: string;
};

export type CompactStrategyResolve = {
  resolvePath(spec: string, kernelFsRoot: string): string;
  defaultSource(): string;
  packageStrategyPath(): string | null;
  readFile(path: string): string;
};

/**
 * The loaded strategy. `source` is what `applyCompact` executes; `sourcePath`
 * is the module root for `(require …)` — a strategy ships its `compact.prompt`
 * next to its `.scm`, and `require` is jailed to that directory.
 */
export function loadCompactProgram(
  spec?: string,
  kernelFsRoot?: string,
  resolve?: CompactStrategyResolve,
): CompactProgram {
  const failsafe = (reason: string): CompactProgram => ({
    source: INLINE_KEEP_FIRST,
    sourcePath: null,
    failsafe: reason,
  });
  if (resolve == null) return failsafe("no strategy resolver");
  let configured: string | null = null;
  try {
    if (spec != null && spec.trim() !== "" && kernelFsRoot != null && kernelFsRoot !== "") {
      const path = resolve.resolvePath(spec, kernelFsRoot);
      const loaded = identityOrSource(resolve.readFile(path));
      if (loaded !== "") return { source: loaded, sourcePath: path };
      configured = `configured strategy ${path} is empty`;
    }
  } catch (error) {
    configured = `configured strategy ${spec ?? ""} could not be read: ${errorText(error)}`;
  }
  try {
    const source = identityOrSource(resolve.defaultSource());
    if (source !== "") return { source, sourcePath: resolve.packageStrategyPath() };
    return failsafe(`${configured ?? "no strategy configured"}; the shipped default program is empty`);
  } catch (error) {
    return failsafe(
      `${configured ?? "no strategy configured"}; the shipped default program could not be read: ${errorText(error)}`,
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identityOrSource(source: string): string {
  const code = source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith(";;");
    })
    .join("\n")
    .trim();
  if (code === "" || code === "()") return "";
  return source;
}
