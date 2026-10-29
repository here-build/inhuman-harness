/** Harness program-source vocabulary: prompt require, the load alias, prompt metadata. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCallJob, FailureOutcome, ProgrammaticJob, SuccessfulOutcome } from "@inhuman.tools/harness-model";
import { interpretSchemeRepl, type SchemeReplHost } from "@inhuman.tools/harness-scheme";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { reaction } from "mobx";
import { describe, expect, it } from "vitest";

import { KernelToolCatalog } from "../../toolkit/tool-table.js";

const TIMEOUT = 15_000;

const ADD_PROMPT = ["---", "output:", "  n: integer", "---", '{{role "user"}}', "x={{x}}", ""].join("\n");

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

async function withAsk(
  job: ProgrammaticJob,
  replHost: SchemeReplHost,
  body: unknown,
  onAsk?: (call: AgentCallJob) => void,
): Promise<void> {
  const errors: unknown[] = [];
  const stop = reaction(
    () => [...job.children],
    (children) => {
      for (const child of children) {
        if (!(child instanceof AgentCallJob) || child.completed) continue;
        try {
          onAsk?.(child);
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
  let failed: unknown;
  try {
    await interpretSchemeRepl(job, replHost);
  } catch (error) {
    failed = error;
  } finally {
    stop();
  }
  if (errors[0] !== undefined) throw errors[0];
  if (failed !== undefined) throw failed;
}

function host(extra: Partial<SchemeReplHost> = {}): SchemeReplHost {
  return {
    catalog: new KernelToolCatalog(),
    root: "/tmp",
    doors: new DoorSession(),
    admit: (call) => {
      throw new Error(`must not admit ${call.function.name}`);
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

async function fixture(): Promise<{ dir: string; sourcePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "harness-program-source-"));
  const sourcePath = join(dir, "main.scm");
  await writeFile(sourcePath, ";; entry\n");
  await writeFile(join(dir, "add.prompt"), ADD_PROMPT);
  await writeFile(join(dir, "data.yaml"), "n: 3\n");
  return { dir, sourcePath };
}

describe("scheme_repl program source", () => {
  it(
    "loads a sibling prompt and yaml, and the ask speech carries the bound argument",
    async () => {
      const { sourcePath } = await fixture();
      let prompts = 0;
      const loaded = program({
        expr: '(list (require "data.yaml") ((require "add.prompt") :x 1))',
        sourcePath,
      });
      await withAsk(loaded, host(), { n: 4 }, (call) => {
        prompts += 1;
        expect(call.speech).toContain("x=1");
      });

      expect({
        prompts,
        outcome: outcome(loaded),
        asked: loaded.children.some((child) => child instanceof AgentCallJob),
      }).toEqual({
        prompts: 1,
        outcome: {
          ok: true,
          value: [expect.stringMatching(/^;; unwrapped \(list/), expect.any(String), expect.any(String)],
          json: expect.objectContaining({ n: 4 }),
        },
        asked: true,
      });
    },
    TIMEOUT,
  );

  it(
    "interactive prompt require, the load alias, and unsupported prompt metadata",
    async () => {
      const { dir } = await fixture();
      let workspacePrompts = 0;
      const workspace = program({ expr: '((require "add.prompt") :x 1)' });
      await withAsk(workspace, host({ root: dir, evalProgram: false }), { n: 4 }, (call) => {
        workspacePrompts += 1;
        expect(call.speech).toContain("x=1");
      });

      await writeFile(join(dir, "lib.scm"), "(define (inc n) (+ n 1))\n");
      const loadedAlias = program({
        expr: '(load "lib.scm") (inc 41)',
      });
      await interpretSchemeRepl(loadedAlias, host({ root: dir, evalProgram: false }));

      const badDir = await mkdtemp(join(tmpdir(), "harness-program-bad-prompt-"));
      const badPath = join(badDir, "main.scm");
      await writeFile(badPath, ";;\n");
      await writeFile(join(badDir, "bad.prompt"), '---\nagent: reviewer\n---\n{{role "user"}}\nx\n');
      const banned = program({ expr: '(require "bad.prompt")', sourcePath: badPath });
      await interpretSchemeRepl(banned, host());

      expect({
        workspace: { prompts: workspacePrompts, outcome: outcome(workspace) },
        loadedAlias: outcome(loadedAlias),
        banned: outcome(banned),
      }).toEqual({
        workspace: {
          prompts: 1,
          outcome: { ok: true, value: [expect.any(String)] },
        },
        loadedAlias: { ok: true, value: ["42"] },
        banned: { ok: false, text: expect.stringMatching(/agent:/) },
      });
    },
    TIMEOUT,
  );
});
