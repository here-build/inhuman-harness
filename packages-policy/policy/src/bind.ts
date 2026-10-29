import { explainBash } from "./check.js";
import { compilePolicy, PolicyAssumeError } from "./compile.js";
import type { Which } from "./identity.js";
import { explainPath, writeRemainderKind } from "./path-policy.js";
import { reasonableDefaults } from "./reasonable-defaults.js";
import { classesOf, type FloorVerdict, type Policy } from "./types.js";
import { cast } from "./verdict.js";

const unresolved: Which = () => undefined;

export function bindPolicy(document: unknown, which: Which = unresolved): Policy {
  const compiled = compilePolicy(document);
  const clusters = { read: compiled.read, write: compiled.write };
  const bash = (command: string, cwd?: string): FloorVerdict =>
    compiled.bash === undefined
      ? cast("ask", "unmodelled", "bash:no-policy")
      : explainBash(compiled.bash, command, clusters, which, cwd);
  for (const smoke of compiled.assume) {
    const verdict = bash(smoke.command);
    const actual = verdict.disposition;
    PolicyAssumeError.invariant(
      actual === smoke.expect,
      `assume: expected ${smoke.expect}, got ${actual}: ${smoke.command}`,
      {
        expected: smoke.expect,
        actual,
        command: smoke.command,
      },
    );
    if (smoke.expectClass !== undefined) {
      const classes = classesOf(verdict);
      PolicyAssumeError.invariant(
        classes.includes(smoke.expectClass),
        `assume: expected class ${smoke.expectClass}, got ${classes.join(",") || "none"}: ${smoke.command}`,
        { expected: smoke.expect, actual, command: smoke.command },
      );
    }
  }
  const path = (cluster: "read" | "write") => {
    const term = cluster === "read" ? compiled.read : compiled.write;
    return (raw: string): FloorVerdict =>
      term === undefined ? cast("ask", "unmodelled", `${cluster}:no-policy`) : explainPath(term, raw);
  };
  const explainRead = path("read");
  const explainWrite = path("write");
  return {
    bash: (command: string, cwd?: string) => bash(command, cwd).disposition,
    explainBash: bash,
    read: (raw: string) => explainRead(raw).disposition,
    explainRead,
    write: (raw: string) => explainWrite(raw).disposition,
    explainWrite,
    writeKind: (raw: string) => (compiled.write === undefined ? null : writeRemainderKind(compiled.write, raw)),
  };
}

/** Dist floor. A path-form argv0 stays a path: this binding has no `which`. */
export const defaultPolicy: Policy = bindPolicy(reasonableDefaults);
