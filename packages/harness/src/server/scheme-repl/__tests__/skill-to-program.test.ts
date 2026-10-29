/**
 * Compiler-shaped eval: real skill-to-program.scm, settled child AgentCallJob.
 * Proves one Markdown file returns a structured bundle, including both
 * repair rounds.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  AGENT_ASK,
  AgentCallJob,
  FailureOutcome,
  ProgrammaticJob,
  SuccessfulOutcome,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { interpretSchemeRepl, type SchemeReplHost } from "@inhuman.tools/harness-scheme";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";
import { reaction } from "mobx";
import { describe, expect, it } from "vitest";

import { KernelToolCatalog } from "../../toolkit/tool-table.js";

const TIMEOUT = 20_000;
const COMPILER = fileURLToPath(new URL("../../../../../../skill-to-program/skill-to-program.scm", import.meta.url));
const MARKDOWN = "# Reverse\n\nReverse the input text.\n";
const SKILL_PATH = "skills/reverse/SKILL.md";

type Stage = "analyze" | "lower" | "emit" | "audit" | "repair";

function outcome(job: ProgrammaticJob): {
  ok: boolean;
  text?: string;
  value?: unknown;
  json?: unknown;
  jsonError?: string;
} {
  return JSON.parse(job.receiptJson ?? "null") as {
    ok: boolean;
    text?: string;
    value?: unknown;
    json?: unknown;
    jsonError?: string;
  };
}

function stageOf(text: string): Stage {
  if (/AUDIT LENS:/.test(text)) return "audit";
  if (text.includes("You are the repair pass")) return "repair";
  if (text.includes("You are the codegen backend")) return "emit";
  if (text.includes("You are the lowering pass")) return "lower";
  if (text.includes("Analyze this skill bundle")) return "analyze";
  throw new Error(`unclassified prompt:\n${text.slice(0, 200)}`);
}

function lensOf(text: string): string {
  return /AUDIT LENS:\s+(\S+)/.exec(text)?.[1] ?? "unknown";
}

function analysis(): Record<string, unknown> {
  return {
    summary: "Reverse the input text.",
    entrypoints: [{ id: "main", purpose: "reverse text", inputs: ["text"], outputs: ["reversed"] }],
    phases: [{ id: "run", purpose: "reverse", dependsOn: [], sourceEvidence: "SKILL.md reverse" }],
    inferenceUnits: [],
    loops: [],
    branches: [],
    parallelRegions: [],
    persistentActors: [],
    effects: [],
    state: [],
    humanGates: [],
    reactiveConditions: [],
    constraints: [],
    uncertainties: [],
  };
}

function lowering(): Record<string, unknown> {
  return {
    entrypoints: [{ id: "main", schemeName: "reverse-text", parameters: ["text"], returns: "string" }],
    functions: [
      {
        id: "main",
        schemeName: "reverse-text",
        purpose: "reverse text",
        parameters: ["text"],
        returns: "string",
        sourceRefs: ["main"],
        constructs: ["string"],
        calls: [],
      },
    ],
    prompts: [],
    actorCalls: [],
    effectBindings: [],
    watches: [],
    humanReentry: [],
    libraryNeeds: [],
    runtimeGaps: [],
    decisions: [{ sourceRef: "main", target: "scheme", targetRef: "reverse-text", rationale: "pure function" }],
    preservationChecks: [{ sourceRefs: ["main"], statement: "reverses the input text" }],
  };
}

function bundle(tag: string): Record<string, unknown> {
  return {
    programPath: "reverse.scm",
    program: `(define (reverse-text text) ${JSON.stringify(tag)})\n`,
    prompts: [],
    requiredCapabilities: [],
    requiredRosterAgents: [],
    watches: [],
    runtimeGaps: [],
    notes: [],
  };
}

function audit(lens: string, passed: boolean): Record<string, unknown> {
  return {
    lens,
    passed,
    confidence: passed ? 1 : 0.2,
    issues: passed
      ? []
      : [
          {
            severity: "error",
            kind: "semantic-mismatch",
            sourceRefs: ["main"],
            message: "missing reverse",
            generatedBehavior: "identity",
            repair: "use reverse",
          },
        ],
  };
}

function watchAsks(
  job: ProgrammaticJob,
  opts: {
    readonly failAudits: number;
    readonly stages: Stage[];
    readonly onAsk?: (text: string) => void;
  },
): { readonly stop: () => void; readonly raised: () => void } {
  let audits = 0;
  const errors: unknown[] = [];
  const stop = reaction(
    () => [...job.children],
    (children) => {
      for (const child of children) {
        if (!(child instanceof AgentCallJob) || child.completed) continue;
        try {
          if (child.name !== AGENT_ASK) throw new Error(`expected ${AGENT_ASK}, got ${child.name}`);
          const text = `${child.systemPrompt}\n${child.speech}`;
          if (child.systemPrompt.trim() === "") throw new Error("empty constitution");
          const stage = stageOf(text);
          opts.stages.push(stage);
          opts.onAsk?.(text);
          const body =
            stage === "analyze"
              ? analysis()
              : stage === "lower"
                ? lowering()
                : stage === "emit" || stage === "repair"
                  ? bundle(stage)
                  : audit(lensOf(text), audits++ >= opts.failAudits);
          child.settleResult(new SuccessfulOutcome({ valueJson: JSON.stringify(body) }));
        } catch (error) {
          errors.push(error);
          child.settleResult(
            new FailureOutcome({
              code: "error",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    },
  );
  return {
    stop,
    raised() {
      if (errors[0] !== undefined) throw errors[0];
    },
  };
}

async function runAsks(
  job: ProgrammaticJob,
  replHost: SchemeReplHost,
  asks: ReturnType<typeof watchAsks>,
): Promise<void> {
  let failed: unknown;
  try {
    await interpretSchemeRepl(job, replHost);
  } catch (error) {
    failed = error;
  } finally {
    asks.stop();
  }
  asks.raised();
  if (failed !== undefined) throw failed;
}

function host(extra: Partial<SchemeReplHost> = {}): SchemeReplHost {
  return {
    catalog: new KernelToolCatalog(),
    root: "/tmp",
    doors: new DoorSession(),
    admit: () => {
      throw new Error("must not admit");
    },
    evalProgram: true,
    connectionId: "c1",
    completionModel: "test-model",
    ...extra,
  };
}

function program(args: unknown): ProgrammaticJob {
  return new ProgrammaticJob({
    toolCallId: "program",
    argsJson: JSON.stringify({ description: "test", ...(args as Record<string, unknown>) }),
  });
}

function readAdmit(files: ReadonlyMap<string, string>): {
  readonly admit: SchemeReplHost["admit"];
  readonly reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    admit: (call: ToolCall) => {
      const args = JSON.parse(call.function.arguments) as { path?: string };
      const path = args.path ?? "";
      reads.push(`${call.function.name}:${path}`);
      const text = files.get(path);
      return new SystemToolJob({
        name: call.function.name,
        toolCallId: call.id,
        completed: true,
        humanApprove: true,
        outcomeJson:
          text == null ? JSON.stringify({ ok: false, text: `ENOENT: ${path}` }) : JSON.stringify({ ok: true, text }),
      });
    },
  };
}

describe("skill-to-program eval", () => {
  it(
    "compiles one Markdown file through eval: pass, path read, missing source, exhausted repairs",
    async () => {
      const source = await readFile(COMPILER, "utf8");
      const sourcePath = COMPILER;

      const passedStages: Stage[] = [];
      const passed = program({
        source,
        sourcePath,
        expr: `(compile-skill-markdown ${JSON.stringify(MARKDOWN)})`,
      });
      await runAsks(passed, host(), watchAsks(passed, { failAudits: 0, stages: passedStages }));

      const pathStages: Stage[] = [];
      const pathReads = readAdmit(new Map([[SKILL_PATH, MARKDOWN]]));
      const fromPath = program({
        source,
        sourcePath,
        expr: `(compile-skill-md ${JSON.stringify(SKILL_PATH)})`,
      });
      let analyzeText = "";
      await runAsks(
        fromPath,
        host({ admit: pathReads.admit }),
        watchAsks(fromPath, {
          failAudits: 0,
          stages: pathStages,
          onAsk: (text) => {
            if (stageOf(text) === "analyze") analyzeText = text;
          },
        }),
      );

      const missingStages: Stage[] = [];
      const missingReads = readAdmit(new Map());
      const missing = program({
        source,
        sourcePath,
        expr: `(compile-skill-md ${JSON.stringify(SKILL_PATH)})`,
      });
      await runAsks(
        missing,
        host({ admit: missingReads.admit }),
        watchAsks(missing, { failAudits: 0, stages: missingStages }),
      );

      const exhaustStages: Stage[] = [];
      const exhaust = program({
        source,
        sourcePath,
        expr: `(compile-skill-markdown ${JSON.stringify(MARKDOWN)})`,
      });
      await runAsks(exhaust, host(), watchAsks(exhaust, { failAudits: 9, stages: exhaustStages }));

      const passedJson = outcome(passed).json as {
        passed?: boolean;
        repairs?: number;
        analysis?: { summary?: string };
        bundle?: { programPath?: string };
        audits?: unknown[];
      };
      const exhaustJson = outcome(exhaust).json as { passed?: boolean; repairs?: number };

      expect({
        passed: {
          stages: passedStages,
          outcome: {
            ok: outcome(passed).ok,
            passed: passedJson.passed,
            repairs: passedJson.repairs,
            summary: passedJson.analysis?.summary,
            programPath: passedJson.bundle?.programPath,
            audits: passedJson.audits?.length,
          },
          pews: passed.children.filter((child) => child instanceof AgentCallJob).length,
          notes: passed.notifications.map((note) => note.message),
        },
        path: {
          stages: pathStages,
          reads: pathReads.reads,
          analyzeHasMarkdown: analyzeText.includes("Reverse the input text"),
          analyzeHasPath: analyzeText.includes(SKILL_PATH),
          ok: outcome(fromPath).ok,
          notes: fromPath.notifications.map((note) => note.message),
        },
        missing: {
          stages: missingStages,
          reads: missingReads.reads,
          outcome: outcome(missing),
          notes: missing.notifications.map((note) => note.message),
        },
        exhaust: {
          stages: exhaustStages,
          outcome: { ok: outcome(exhaust).ok, passed: exhaustJson.passed, repairs: exhaustJson.repairs },
          notes: exhaust.notifications.map((note) => note.message),
        },
      }).toEqual({
        passed: {
          stages: ["analyze", "lower", "emit", "audit", "audit", "audit"],
          outcome: {
            ok: true,
            passed: true,
            repairs: 0,
            summary: "Reverse the input text.",
            programPath: "reverse.scm",
            audits: 3,
          },
          pews: 6,
          notes: [],
        },
        path: {
          stages: ["analyze", "lower", "emit", "audit", "audit", "audit"],
          reads: [`read_file:${SKILL_PATH}`],
          analyzeHasMarkdown: true,
          analyzeHasPath: true,
          ok: true,
          notes: [],
        },
        missing: {
          stages: [],
          reads: [`read_file:${SKILL_PATH}`],
          outcome: { ok: false, text: expect.stringMatching(/ENOENT|read_file|skills\/reverse/) },
          notes: [],
        },
        exhaust: {
          stages: [
            "analyze",
            "lower",
            "emit",
            "audit",
            "audit",
            "audit",
            "repair",
            "audit",
            "audit",
            "audit",
            "repair",
            "audit",
            "audit",
            "audit",
          ],
          outcome: { ok: true, passed: false, repairs: 2 },
          notes: [],
        },
      });
    },
    TIMEOUT,
  );
});
