/**
 * Host-side command inspection. The command is data, never shell source
 * for the child. `analysis_incomplete` is not one threat: intel-gap
 * (offline package lookup) is not a vote, nested-incomplete-only is
 * remainder ask, concrete rules and scanner error keep today's map.
 */
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findingSchema, outputSchema, type TirithFinding, type TirithOutput } from "./schemas/tirith.js";
import { tirithUnits } from "./tirith-units.js";

export type TirithReport = {
  readonly action: "allow" | "warn" | "block" | "error";
  readonly findings: readonly TirithFinding[];
  readonly error?: string;
};

type ShellCheckOptions = { readonly cwd: string; readonly signal?: AbortSignal };
export type ShellChecker = (command: string, options: ShellCheckOptions) => Promise<TirithReport>;

const policyRoot = fileURLToPath(new URL("../tirith-policy/", import.meta.url));
const policyPath = path.join(policyRoot, ".tirith", "policy.yaml");
const codes = { allow: 0, warn: 2, block: 1 } as const;

export function parseTirithOutput(stdout: string, code: number | null): TirithOutput {
  const output = outputSchema.parse(JSON.parse(stdout) as unknown);
  if (codes[output.action] !== code) throw new Error(`Tirith verdict disagrees with exit code ${code}`);
  return output;
}

export function tirithFailure(error: unknown): TirithReport {
  return { action: "error", findings: [], error: error instanceof Error ? error.message : String(error) };
}

const INCOMPLETE_RULE = "analysis_incomplete";
const INTERNAL_COPY = /tirith|getvet\.sh|policy\.yaml|scan\.require|operator policy|capsule command|--suggest/i;
const BUDGET_NOTE = /nested body suffix omitted|bounded analysis|coverage gap/i;

const INCOMPLETE_MESSAGE =
  "Policy safeguards were unable to classify this shell script's safety. It may be correct to use, but it is too complex for static analysis; try to produce a simpler or more explicit shell script that will do the same thing.";

type TirithCoverage = "error" | "concrete" | "incomplete" | "intel-gap" | "none";

export function tirithCoverage(report: TirithReport): TirithCoverage {
  if (report.action === "error") return "error";
  if (report.findings.length === 0) return "none";
  if (report.findings.some((finding) => finding.rule_id !== INCOMPLETE_RULE)) return "concrete";
  if (report.findings.every(isIntelGapFinding)) return "intel-gap";
  return "incomplete";
}

function isIntelGapFinding(finding: TirithFinding): boolean {
  const evidence = finding.evidence ?? [];
  return evidence.length > 0 && evidence.every((item) => item.type === "threat_intel");
}

/** A block only when a finding is the attack itself. A coarse shape stays a question. */
const HARD_BLOCK = new Set([
  "pipe_to_interpreter",
  "curl_pipe_shell",
  "wget_pipe_shell",
  "httpie_pipe_shell",
  "xh_pipe_shell",
  "base64_decode_execute",
  "sudo_download_install",
  "reverse_shell",
  "proc_mem_access",
  "docker_remote_priv_esc",
  "plain_http_to_sink",
  "schemeless_to_sink",
  "insecure_tls_flags",
  "userinfo_trick",
  "non_ascii_hostname",
  "metadata_endpoint",
  "data_exfiltration",
  "dotfile_overwrite",
  "private_key_exposed",
  "sudo_shell_spawn",
  "sudo_env_preserve_sensitive",
  "sudo_tee_system_file",
  "sudo_recursive_perms_broad_path",
  "blast_writes_system_path",
  "blast_find_delete",
  "blast_rsync_delete",
  "wrapper_chain_too_deep",
]);

function hardBlock(report: TirithReport): boolean {
  return report.findings.some((finding) => HARD_BLOCK.has(finding.rule_id));
}

/**
 * Coarse shapes: a pattern that is often an attack and often a legitimate address (a LAN host, a
 * link shortener). They are soft-deny (class `attack-shape`): licensed per call, never remembered.
 */
const COARSE = new Set(["private_network_access", "shortened_url"]);

function coarseShape(report: TirithReport): boolean {
  return report.findings.some((finding) => COARSE.has(finding.rule_id));
}

type TirithFloor = "policyApprove" | "ask" | "deny" | "block";

/** Class of a Tirith vote: the scanner failing is a policy fault, anything else an attack shape. */
export function tirithClass(report: TirithReport): "attack-shape" | "policy-fault" {
  return tirithCoverage(report) === "error" ? "policy-fault" : "attack-shape";
}

export function tirithDisposition(report: TirithReport): TirithFloor {
  switch (tirithCoverage(report)) {
    case "error":
      return "block";
    case "intel-gap":
    case "none":
      return "policyApprove";
    case "incomplete":
      return "ask";
    case "concrete":
      if (report.action === "allow") return "policyApprove";
      if (report.action === "warn") return "ask";
      if (hardBlock(report)) return "block";
      return coarseShape(report) ? "deny" : "ask";
  }
}

/** Model-facing. Scanner identity stays in `policyEvidenceJson`. */
export function tirithMessage(report: TirithReport): string | null {
  switch (tirithCoverage(report)) {
    case "error":
      return "Policy safeguards could not inspect this command.";
    case "intel-gap":
    case "none":
      return null;
    case "incomplete":
      return withFragments(INCOMPLETE_MESSAGE, commandSnippets(report.findings));
    case "concrete": {
      const concrete = report.findings.filter((finding) => finding.rule_id !== INCOMPLETE_RULE);
      const parts = concrete.map(findingAdvice).filter((part) => part !== "");
      return parts.length === 0 ? null : parts.join("\n\n");
    }
  }
}

/** Classifier PIP. Concrete findings only — no-verdicts are not threats. */
export function tirithPolicyCut(report: TirithReport): string {
  if (tirithCoverage(report) !== "concrete") return "";
  return tirithMessage(report) ?? "";
}

export function parseTirithEvidence(json: string | null | undefined): TirithReport | null {
  if (json == null || json === "") return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) return null;
    return asReport(parsed.tirith);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asReport(value: unknown): TirithReport | null {
  if (!isRecord(value)) return null;
  const action = value.action;
  if (action !== "allow" && action !== "warn" && action !== "block" && action !== "error") return null;
  if (!Array.isArray(value.findings)) return null;
  const findings: TirithFinding[] = [];
  for (const item of value.findings) {
    const parsed = findingSchema.safeParse(item);
    if (!parsed.success) return null;
    findings.push(parsed.data);
  }
  const error = value.error;
  return typeof error === "string" ? { action, findings, error } : { action, findings };
}

function findingAdvice(finding: TirithFinding): string {
  const body = modelSentences(finding.description) || modelSentences(finding.title);
  const snips = commandSnippets([finding]);
  const hit = finding.evidence?.find((item) => item.pattern != null && item.pattern !== "")?.pattern;
  const parts: string[] = [];
  if (body !== "") parts.push(body);
  if (snips.length > 0) parts.push(`This fragment:\n${snips.map((snip) => `  ${snip}`).join("\n")}`);
  if (hit !== undefined) parts.push(`Why: it matches ${hit}.`);
  switch (finding.rule_id) {
    case "interpreter_suspicious_inline_exec":
      parts.push(
        "Drop the spawn, socket, or eval, or move that part into a file and run the file. A one-liner that only computes is already allowed.",
      );
      break;
    case "mass_file_deletion":
      parts.push(
        "Delete fewer than three files in one step, or name the build directory you mean (node_modules, dist, target). Do not chain the rest into one command.",
      );
      break;
    default: {
      const rem = finding.remediation === undefined ? "" : modelSentences(finding.remediation);
      if (rem !== "" && rem !== body) parts.push(rem);
    }
  }
  return parts.join("\n");
}

function withFragments(lead: string, snips: readonly string[]): string {
  if (snips.length === 0) return lead;
  return `${lead}\n\nThis fragment could not be classified:\n${snips.map((snip) => `  ${snip}`).join("\n")}`;
}

function commandSnippets(findings: readonly TirithFinding[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const finding of findings) {
    for (const item of finding.evidence ?? []) {
      const text = item.matched ?? item.raw;
      if (text == null || text === "" || BUDGET_NOTE.test(text) || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function modelSentences(text: string): string {
  return text
    .split(/(?<=\.)\s+/)
    .filter((sentence) => sentence !== "" && !INTERNAL_COPY.test(sentence))
    .join(" ")
    .trim();
}

function binaryPath(): string {
  const require = createRequire(import.meta.url);
  const fromTirith = createRequire(require.resolve("tirith/package.json"));
  const platform = `${process.platform}-${process.arch}`;
  if (!["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].includes(platform)) {
    throw new Error(`Unsupported Tirith platform: ${platform}`);
  }
  const root = path.dirname(fromTirith.resolve(`@sheeki03/tirith-${platform}/package.json`));
  return path.join(root, "bin", process.platform === "win32" ? "tirith.exe" : "tirith");
}

/** Do not inherit TIRITH*, loader injection, user allowlists, or project policy discovery. */
function scannerEnv(state: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: state,
    USERPROFILE: state,
    XDG_CONFIG_HOME: state,
    XDG_DATA_HOME: state,
    XDG_CACHE_HOME: state,
    APPDATA: state,
    LOCALAPPDATA: state,
    TIRITH_POLICY_ROOT: policyRoot,
    TIRITH_LOG: "0",
    TIRITH_OFFLINE: "1",
  };
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function joinTirithReports(reports: readonly TirithReport[]): TirithReport {
  const findings = reports.flatMap((report) => report.findings);
  if (reports.some((report) => report.action === "block")) return { action: "block", findings };
  const failed = reports.find((report) => report.action === "error");
  if (failed !== undefined) return { action: "error", findings, error: failed.error };
  if (reports.some((report) => report.action === "warn")) return { action: "warn", findings };
  return { action: "allow", findings };
}

function inspectCommand(
  binary: string,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<TirithOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["check", "--format", "json", "--non-interactive", "--no-daemon", "--offline", "--shell", "posix", "--", command],
      {
        cwd,
        env,
        signal,
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => {
        try {
          if (error == null) {
            resolve(parseTirithOutput(stdout, 0));
            return;
          }
          const code = error.code;
          if (error.killed || error.signal || typeof code !== "number") throw error;
          resolve(parseTirithOutput(stdout, code));
        } catch (error_) {
          reject(error_);
        }
      },
    );
  });
}

export const checkTirith: ShellChecker = async (command, { cwd, signal }) => {
  let state: string | undefined;
  try {
    signal?.throwIfAborted();
    const binary = binaryPath();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed package asset, never caller input
    await realpath(policyPath);
    const home = await mkdtemp(path.join(tmpdir(), "harness-tirith-"));
    state = home;
    signal?.throwIfAborted();
    const env = scannerEnv(home);
    const reports = await Promise.all(
      tirithUnits(command).map(async (unit) => {
        try {
          const output = await inspectCommand(binary, unit, cwd, env, signal);
          if (!output.policy_path_used) {
            throw new Error("Tirith did not use the package-owned policy");
          }
          return { action: output.action, findings: output.findings } satisfies TirithReport;
        } catch (error) {
          return tirithFailure(error);
        }
      }),
    );
    return joinTirithReports(reports);
  } catch (error) {
    return tirithFailure(error);
  } finally {
    if (state !== undefined) await rm(state, { recursive: true, force: true });
  }
};
