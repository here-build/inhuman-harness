/**
 * Compile a policy.json document into CommandNode + path terms.
 * `"--"` is a handle, not a subcommand: omitted `policy` inherits.
 * Extra keys on a command object are refused — verbs live under `subcommands`.
 */

import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";

import { isClassId, type ClassId } from "./classes.js";
import { GUARDS } from "./guards.js";
import { mergePathTerms, normalizePath, type PathTerm } from "./path-policy.js";
import type { ArgType, CommandNode, Disposition, FlagConstraint, Matcher } from "./types.js";

type PathRule = PathTerm["rules"][number];

export class PolicyCompileError extends ErrorWithInvariant {
  override readonly name = "PolicyCompileError";
}

export class PolicyAssumeError extends ErrorWithInvariant {
  override readonly name = "PolicyAssumeError";
  readonly expected?: Disposition;
  readonly actual?: Disposition;
  readonly command?: string;

  constructor(message: string, detail?: { expected: Disposition; actual: Disposition; command: string }) {
    super(message);
    if (detail !== undefined) {
      this.expected = detail.expected;
      this.actual = detail.actual;
      this.command = detail.command;
    }
  }
}

const DISPS = new Set(["policyApprove", "approve", "allow", "ask", "deny", "block"]);
const RESERVED = new Set([
  "policy",
  "class",
  "family_args",
  "arg_types",
  "arg_rest_type",
  "flag_paths",
  "guard",
  "matcher",
  "--",
  "subcommands",
]);

type AssumeSmoke = {
  readonly command: string;
  readonly expect: Disposition;
  /** Asserted against the classes of the votes that decided the tier. */
  readonly expectClass?: ClassId;
};

type CompiledDocument = {
  readonly bash?: CommandNode;
  readonly read?: PathTerm;
  readonly write?: PathTerm;
  readonly assume: readonly AssumeSmoke[];
};

export function compilePolicy(document: unknown): CompiledDocument {
  const raw = document;
  if (raw === null || raw === undefined) return { assume: [] };
  PolicyCompileError.invariant(isRecord(raw), "policy.json: document must be a mapping");
  const unknown = Object.keys(raw).filter(
    (key) =>
      !key.startsWith(".") &&
      ![
        "read_file",
        "write_file",
        "read_block",
        "write_block",
        "bash",
        "assume",
        "read_miss_class",
        "write_miss_class",
      ].includes(key),
  );
  PolicyCompileError.invariant(unknown.length === 0, `policy.json: unknown top-level key ${unknown[0]}`);
  const readMiss = parseClass(raw.read_miss_class, "read_miss_class") ?? "envelope-read";
  const writeMiss = parseClass(raw.write_miss_class, "write_miss_class") ?? "envelope-write";
  return {
    bash: raw.bash === undefined ? undefined : parseCommandDef(raw.bash, "bash", true),
    read: mergePathTerms(
      "read",
      readMiss,
      parsePathList(raw.read_file, "read_file", "policyApprove", "envelope-read"),
      parseBlockList(raw.read_block, "read_block", "credential"),
    ),
    write: mergePathTerms(
      "write",
      writeMiss,
      parsePathList(raw.write_file, "write_file", "ask", "workspace-write"),
      parseBlockList(raw.write_block, "write_block", "control-plane"),
    ),
    assume: parseAssume(raw.assume),
  };
}

/** A class id from the closed taxonomy. An unknown id is a compile error, never a new class. */
function parseClass(value: unknown, path: string): ClassId | undefined {
  if (value === undefined) return undefined;
  PolicyCompileError.invariant(isClassId(value), `policy.json: unknown class ${String(value)} at ${path}`);
  return value;
}

/** A path item is a string, or `{ path, class }` to tag the rule with a dist class. */
function pathItem(item: unknown, field: string): { readonly pattern: string; readonly class?: ClassId } {
  if (typeof item === "string") return { pattern: item };
  PolicyCompileError.invariant(isRecord(item), `${field}: each pattern is a string or { path, class }`);
  const extra = Object.keys(item).filter((key) => key !== "path" && key !== "class");
  PolicyCompileError.invariant(extra.length === 0, `${field}: unknown key ${extra[0]}`);
  PolicyCompileError.invariant(typeof item.path === "string", `${field}: { path } is a string`);
  return { pattern: item.path, class: parseClass(item.class, `${field}.class`) };
}

function parsePathList(
  value: unknown,
  field: string,
  enable: "policyApprove" | "ask",
  enableClass: ClassId,
): PathRule[] | undefined {
  if (value === undefined) return undefined;
  PolicyCompileError.invariant(Array.isArray(value), `${field}: list of strings`);
  return value.map((raw) => {
    const { pattern: item, class: tagged } = pathItem(raw, field);
    PolicyCompileError.invariant(
      !item.startsWith("-"),
      "path pattern: - is not a prefix; ! is deny on the enable list",
    );
    const deny = item.startsWith("!");
    const stem = normalizePath(deny ? item.slice(1) : item);
    PolicyCompileError.invariant(stem !== undefined, "path pattern: empty or unresolvable");
    return {
      id: `${field}:${deny ? "!" : ""}${stem}`,
      polarity: deny ? "deny" : enable,
      stem,
      unanchored: stem !== "." && !stem.startsWith("/") && !stem.includes("/"),
      class: tagged ?? (deny ? "protected-file" : enableClass),
    } satisfies PathRule;
  });
}

function parseBlockList(value: unknown, field: string, defaultClass: ClassId): PathRule[] | undefined {
  if (value === undefined) return undefined;
  PolicyCompileError.invariant(Array.isArray(value), `${field}: list of strings`);
  return value.map((raw) => {
    const { pattern: item, class: tagged } = pathItem(raw, field);
    PolicyCompileError.invariant(
      !item.startsWith("!") && !item.startsWith("-"),
      "block list: stem without a polarity prefix",
    );
    const stem = normalizePath(item);
    PolicyCompileError.invariant(stem !== undefined, "path pattern: empty or unresolvable");
    return {
      id: `${field}:${stem}`,
      polarity: "block" as const,
      stem,
      unanchored: stem !== "." && !stem.startsWith("/") && !stem.includes("/"),
      class: tagged ?? defaultClass,
    } satisfies PathRule;
  });
}

function parseAssume(value: unknown): AssumeSmoke[] {
  if (value === undefined) return [];
  PolicyCompileError.invariant(Array.isArray(value), "assume: list of { command, expect }");
  return value.map((item, i) => {
    PolicyCompileError.invariant(isRecord(item), `assume[${i}]: mapping`);
    PolicyCompileError.invariant(typeof item.command === "string", `assume[${i}]: command is a string`);
    const expect = asDisposition(item.expect);
    PolicyCompileError.invariant(expect !== undefined, `assume[${i}]: expect is approve|ask|deny|block`);
    const expectClass = parseClass(item.expect_class, `assume[${i}].expect_class`);
    return { command: item.command, expect, ...(expectClass === undefined ? {} : { expectClass }) };
  });
}

function parseFamilyArgs(value: unknown, path: string): number {
  if (value === undefined) return 0;
  PolicyCompileError.invariant(
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4,
    `${path}.family_args: integer 0..4`,
  );
  return value;
}

function parseCommandDef(value: unknown, path: string, policyRequired: boolean): CommandNode {
  const disp = asDisposition(value);
  if (disp !== undefined) {
    return { policy: disp, familyArgs: 0, argTypes: [], flagPaths: {}, guards: [], matchers: [], subcommands: {} };
  }
  PolicyCompileError.invariant(isRecord(value), `${path}: command is a disposition or a mapping`);
  const extra = Object.keys(value).filter((key) => !RESERVED.has(key));
  PolicyCompileError.invariant(extra.length === 0, `${path}: unknown key ${extra[0]} — verbs go under subcommands`);
  const policy = value.policy === undefined ? undefined : asDisposition(value.policy);
  PolicyCompileError.invariant(
    value.policy === undefined || policy !== undefined,
    `${path}.policy: approve|ask|deny|block`,
  );
  PolicyCompileError.invariant(!policyRequired || policy !== undefined, `${path}: policy is required`);
  const subcommands: Record<string, CommandNode> = {};
  if (value.subcommands !== undefined) {
    PolicyCompileError.invariant(isRecord(value.subcommands), `${path}.subcommands: mapping`);
    for (const [name, def] of Object.entries(value.subcommands)) {
      subcommands[String(name)] = parseCommandDef(def, `${path}.subcommands.${name}`, true);
    }
  }
  return {
    policy,
    class: parseClass(value.class, `${path}.class`),
    familyArgs: parseFamilyArgs(value.family_args, path),
    argTypes: parseArgTypes(value.arg_types, `${path}.arg_types`),
    argRestType: parseArgType(value.arg_rest_type, `${path}.arg_rest_type`),
    flagPaths: parseFlagPaths(value.flag_paths, `${path}.flag_paths`),
    guards: parseGuards(value.guard, `${path}.guard`),
    matchers: parseMatchers(value.matcher, `${path}.matcher`),
    dash: value["--"] === undefined ? undefined : parseCommandDef(value["--"], `${path}.--`, false),
    subcommands,
  };
}

function parseArgTypes(value: unknown, path: string): ArgType[] {
  if (value === undefined) return [];
  PolicyCompileError.invariant(Array.isArray(value), `${path}: list`);
  return value.map((item, i) => {
    const parsed = parseArgType(item, `${path}[${i}]`);
    PolicyCompileError.invariant(parsed !== undefined, `${path}[${i}]: missing`);
    return parsed;
  });
}

function parseArgType(value: unknown, path: string): ArgType | undefined {
  if (value === undefined) return undefined;
  PolicyCompileError.invariant(value === "read_path" || value === "write_path", `${path}: read_path|write_path`);
  return value;
}

/** `{ "--output": "write_path", "-o": "write_path" }`. Long names also match every unambiguous-prefix spelling. */
function parseFlagPaths(value: unknown, path: string): Record<string, ArgType> {
  if (value === undefined) return {};
  PolicyCompileError.invariant(isRecord(value), `${path}: mapping of option to read_path|write_path`);
  const out: Record<string, ArgType> = {};
  for (const [name, kind] of Object.entries(value)) {
    PolicyCompileError.invariant(name.startsWith("-"), `${path}.${name}: option name`);
    const parsed = parseArgType(kind, `${path}.${name}`);
    PolicyCompileError.invariant(parsed !== undefined, `${path}.${name}: missing`);
    for (const spelling of withPrefixes([name])) out[spelling] = parsed;
  }
  return out;
}

function parseGuards(value: unknown, path: string): string[] {
  const names = stringList(value, path);
  for (const name of names) PolicyCompileError.invariant(GUARDS.has(name), `${path}: unknown guard ${name}`);
  return names;
}

/** getopt_long accepts any unique prefix of a long option; the policy treats every prefix as the option. */
function withPrefixes(names: readonly string[]): string[] {
  const out = new Set(names);
  for (const name of names) {
    if (!name.startsWith("--")) continue;
    for (let end = 3; end < name.length; end += 1) out.add(name.slice(0, end));
  }
  return [...out];
}

function parseMatchers(value: unknown, path: string): Matcher[] {
  if (value === undefined) return [];
  PolicyCompileError.invariant(Array.isArray(value), `${path}: list`);
  return value.map((item, i) => {
    const here = `${path}[${i}]`;
    PolicyCompileError.invariant(isRecord(item), `${here}: mapping`);
    const extra = Object.keys(item).filter(
      (key) => !["flags", "glob", "tok", "matcher", "policy", "class"].includes(key),
    );
    PolicyCompileError.invariant(extra.length === 0, `${here}: unknown key ${extra[0]}`);
    const policy = item.policy === undefined ? undefined : asDisposition(item.policy);
    PolicyCompileError.invariant(
      item.policy === undefined || policy !== undefined,
      `${here}.policy: approve|ask|deny|block`,
    );
    return {
      class: parseClass(item.class, `${here}.class`),
      flags: parseFlags(item.flags, `${here}.flags`),
      globs: stringList(item.glob, `${here}.glob`),
      toks: stringList(item.tok, `${here}.tok`),
      matchers: parseMatchers(item.matcher, `${here}.matcher`),
      policy,
    };
  });
}

function parseFlags(value: unknown, path: string): Record<string, FlagConstraint> {
  if (value === undefined) return {};
  PolicyCompileError.invariant(isRecord(value), `${path}: mapping`);
  const out: Record<string, FlagConstraint> = {};
  for (const [raw, spec] of Object.entries(value)) {
    const canonical = String(raw);
    out[canonical] = parseFlagConstraint(spec, canonical, `${path}.${canonical}`);
  }
  return out;
}

function parseFlagConstraint(value: unknown, canonical: string, path: string): FlagConstraint {
  if (value === true || value === null) {
    return { names: [canonical], vals: [], takesValue: false };
  }
  PolicyCompileError.invariant(isRecord(value), `${path}: true or { alias, value, value_type }`);
  const extra = Object.keys(value).filter((key) => !["alias", "value", "value_type", "abbrev"].includes(key));
  PolicyCompileError.invariant(extra.length === 0, `${path}: unknown key ${extra[0]}`);
  const aliases = stringList(value.alias, `${path}.alias`);
  const vals = stringList(value.value, `${path}.value`);
  const takesValue = vals.length > 0 || value.value_type !== undefined;
  if (value.value_type !== undefined) {
    PolicyCompileError.invariant(typeof value.value_type === "string", `${path}.value_type: string`);
  }
  PolicyCompileError.invariant(
    value.abbrev === undefined || typeof value.abbrev === "boolean",
    `${path}.abbrev: boolean`,
  );
  const names = [canonical, ...aliases];
  return { names: value.abbrev === true ? withPrefixes(names) : names, vals, takesValue };
}

function stringList(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  PolicyCompileError.invariant(Array.isArray(value), `${path}: string or list of strings`);
  return value.map((item, i) => {
    PolicyCompileError.invariant(typeof item === "string", `${path}[${i}]: string`);
    return item;
  });
}

function asDisposition(value: unknown): Disposition | undefined {
  if (typeof value !== "string" || !DISPS.has(value)) return undefined;
  if (value === "allow" || value === "approve" || value === "policyApprove") return "policyApprove";
  return value as Disposition;
}

export function flagVocab(node: CommandNode): Set<string> {
  const names = new Set<string>();
  addMatcherFlags(node.matchers, names, false);
  return names;
}

export function valueFlagNames(node: CommandNode): Set<string> {
  const names = new Set<string>();
  addMatcherFlags(node.matchers, names, true);
  for (const name of Object.keys(node.flagPaths)) names.add(name);
  return names;
}

function addMatcherFlags(matchers: readonly Matcher[], names: Set<string>, valueOnly: boolean): void {
  for (const matcher of matchers) {
    for (const flag of Object.values(matcher.flags)) {
      if (valueOnly && !flag.takesValue) continue;
      for (const name of flag.names) names.add(name);
    }
    addMatcherFlags(matcher.matchers, names, valueOnly);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
