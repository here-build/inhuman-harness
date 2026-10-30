/**
 * `run(argv, streams)` against a temporary daemon. The client never writes
 * `approved`; stdout is only the program value.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { HarnessDaemon } from "@inhuman.tools/harness/testkit";
import { ApprovableJob, evalProgramOf, findEvalTurnByRequestId } from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { termSessionKey, type Streams } from "@inhuman.tools/harness-sdk/launch";
import { walkWork } from "@inhuman.tools/plexus-expectations";
import { when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";

import { run } from "../../bin.js";

const TIMEOUT = 20_000;

function capture(
  input = "",
  cwd = "",
): {
  readonly streams: Streams;
  readonly stdout: string;
  readonly stderr: string;
} {
  let stdout = "";
  let stderr = "";
  let pushed = false;
  const streams: Streams = {
    stdin: Object.assign(
      new Readable({
        read() {
          if (!pushed) {
            pushed = true;
            if (input !== "") this.push(input);
          }
          this.push(null);
        },
      }),
      { isTTY: false },
    ) as NodeJS.ReadStream,
    stdout: new Writable({
      write(chunk, _enc, cb) {
        stdout += String(chunk);
        cb();
      },
    }) as NodeJS.WriteStream,
    stderr: new Writable({
      write(chunk, _enc, cb) {
        stderr += String(chunk);
        cb();
      },
    }) as NodeJS.WriteStream,
    cwd,
  };
  return {
    streams,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function openWorld(): Promise<{
  readonly kernel: string;
  readonly workspace: string;
  readonly daemon: HarnessDaemon;
}> {
  const kernel = await mkdtemp(join(tmpdir(), "harness-eval-cli-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-eval-cli-p-"));
  onTestFinished(async () => {
    await rm(kernel, { recursive: true, force: true, maxRetries: 10 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 10 });
  });
  await writeFile(join(kernel, "config.json"), JSON.stringify({ connections: {} }));
  const daemon = new HarnessDaemon(kernel);
  await daemon.listen();
  onTestFinished(async () => {
    await daemon[Symbol.asyncDispose]();
  });
  return { kernel, workspace, daemon };
}

describe("eval CLI", () => {
  it(
    "prints 3 from (+ 1 2) without a client approval write",
    async () => {
      const { kernel, workspace, daemon } = await openWorld();
      const cap = capture("", workspace);
      const result = await run(["-e", "(+ 1 2)", "--kernel", kernel], cap.streams);
      const project = await daemon.project(workspace);
      const session = Object.values(project.sessions)[0];
      const turn = session?.root.head;
      const approved = [...(turn == null ? [] : walkWork(turn))].filter(
        (node): node is ApprovableJob => node instanceof ApprovableJob,
      );
      expect({
        code: result.code,
        stdout: cap.stdout,
        stderr: cap.stderr,
        policy: turn?.evalSpec?.permissionMode,
        prompt: turn?.prompt,
        outcome: evalProgramOf(turn!)?.outcomeSnap,
        humanApprove: approved,
        comments: approved.map((leaf) => leaf.approvalComment),
        stdoutLeak: /connect later|scheme_repl/.test(cap.stdout),
      }).toEqual({
        code: 0,
        stdout: "3\n",
        stderr: expect.stringMatching(/connect later with --resume \S+\nscheme_repl {2}\{1 \+ 2\}/),
        policy: "auto",
        prompt: "",
        outcome: { ok: true, value: ["3"] },
        humanApprove: [],
        comments: [],
        stdoutLeak: false,
      });
    },
    TIMEOUT,
  );

  it(
    "reconnects to the same admitted program after the daemon restarts",
    async () => {
      const { kernel, workspace, daemon } = await openWorld();
      const cap = capture("", workspace);
      const result = await run(["-e", "(+ 1 2)", "--kernel", kernel], cap.streams);
      const sessionId = /connect later with --resume (\S+)/.exec(cap.stderr)?.[1];
      await daemon[Symbol.asyncDispose]();
      const again = new HarnessDaemon(kernel);
      await again.listen();
      onTestFinished(async () => {
        await again[Symbol.asyncDispose]();
      });
      await using client = await Client.connect(kernel, workspace, sessionId!);
      const turn = [...client.sessionRoot.liveTurns].find((node) => node.evalSpec != null);
      expect({
        first: { code: result.code, sessionId: sessionId != null && sessionId !== "" },
        again: {
          outcome: evalProgramOf(turn!)?.outcomeSnap,
          policy: turn?.evalSpec?.permissionMode,
        },
      }).toEqual({
        first: { code: 0, sessionId: true },
        again: { outcome: { ok: true, value: ["3"] }, policy: "auto" },
      });
    },
    TIMEOUT,
  );

  it(
    "stamps termContinue so --continue can restore the eval session",
    async () => {
      const { kernel, workspace } = await openWorld();
      const prior = process.env.TERM_SESSION_ID;
      process.env.TERM_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      try {
        const cap = capture("", workspace);
        const result = await run(["-e", "(+ 1 2)", "--kernel", kernel], cap.streams);
        const sessionId = /connect later with --resume (\S+)/.exec(cap.stderr)?.[1];
        const key = termSessionKey(process.env);
        await using handle = await Client.kernel(kernel);
        expect({
          run: { code: result.code, sessionId, key },
          stamped: handle.plexus.root.termContinue[key!],
          exists: await Client.sessionExists(kernel, sessionId!),
        }).toEqual({
          run: {
            code: 0,
            sessionId: expect.any(String),
            key: expect.stringContaining("emu=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
          },
          stamped: sessionId,
          exists: true,
        });
      } finally {
        if (prior === undefined) delete process.env.TERM_SESSION_ID;
        else process.env.TERM_SESSION_ID = prior;
      }
    },
    TIMEOUT,
  );

  it(
    "reads a file and stdin and fails mixed forms with empty stdout",
    async () => {
      const { kernel, workspace } = await openWorld();
      const file = join(workspace, "add.scm");
      await writeFile(file, "(+ 1 2)\n");
      const fromFile = capture("", workspace);
      const fileResult = await run([file, "--kernel", kernel], fromFile.streams);
      const fromStdin = capture("(+ 10 20)", workspace);
      const stdinResult = await run(["-e", "-", "--kernel", kernel], fromStdin.streams);
      const jsonCap = capture("", workspace);
      const jsonResult = await run(["-e", "#t", "--format", "json", "--kernel", kernel], jsonCap.streams);
      const blank = capture("", workspace);
      const blankResult = await run(["-e", "   ", "--kernel", kernel], blank.streams);
      const failed = capture("", workspace);
      const failResult = await run(["-e", "(not-a-bound-verb) 1", "--kernel", kernel], failed.streams);
      expect({
        file: { code: fileResult.code, stdout: fromFile.stdout },
        stdin: { code: stdinResult.code, stdout: fromStdin.stdout },
        json: { code: jsonResult.code, stdout: jsonCap.stdout },
        blank: { code: blankResult.code, stdout: blank.stdout },
        mixed: { code: failResult.code, stdout: failed.stdout },
      }).toEqual({
        file: { code: 0, stdout: "3\n" },
        stdin: { code: 0, stdout: "30\n" },
        json: { code: 0, stdout: '"#t"\n' },
        blank: { code: 1, stdout: "" },
        mixed: { code: 1, stdout: "" },
      });
    },
    TIMEOUT,
  );

  it(
    "prints self/notify on stderr and keeps the value on stdout",
    async () => {
      const { kernel, workspace } = await openWorld();
      const cap = capture("", workspace);
      const result = await run(["-e", '(begin (self/notify "analyzing") 3)', "--kernel", kernel], cap.streams);
      expect({
        code: result.code,
        stdout: cap.stdout,
        notify: /analyzing/.test(cap.stderr),
        stdoutLeak: /analyzing/.test(cap.stdout),
      }).toEqual({
        code: 0,
        stdout: "3\n",
        notify: true,
        stdoutLeak: false,
      });
    },
    TIMEOUT,
  );

  it(
    "loads a file then evaluates -e; json objects use the structured sibling",
    async () => {
      const { kernel, workspace } = await openWorld();
      const file = join(workspace, "lib.scm");
      await writeFile(file, "(define (add a b) (+ a b))\n");
      const call = capture("", workspace);
      const called = await run([file, "-e", "(add 2 3)", "--kernel", kernel], call.streams);
      const broken = join(workspace, "broken.scm");
      await writeFile(broken, "(not-bound)\n");
      const failCap = capture("", workspace);
      const failed = await run([broken, "-e", "99", "--kernel", kernel], failCap.streams);
      const jsonCap = capture("", workspace);
      const jsonResult = await run(
        ["-e", "{ :passed #t :repairs 0 }", "--format", "json", "--kernel", kernel],
        jsonCap.streams,
      );
      expect({
        call: { code: called.code, stdout: call.stdout },
        failed: { code: failed.code, stdout: failCap.stdout, stderr: failCap.stderr },
        json: { code: jsonResult.code, body: JSON.parse(jsonCap.stdout) },
      }).toEqual({
        call: { code: 0, stdout: "5\n" },
        failed: { code: 1, stdout: "", stderr: expect.stringMatching(/Unbound|unbound|not-bound/) },
        json: { code: 0, body: expect.objectContaining({ passed: true, repairs: 0 }) },
      });
    },
    TIMEOUT,
  );

  it(
    "-p compiles to bot/send on the admitted program",
    async () => {
      const { kernel, workspace, daemon } = await openWorld();
      const cap = capture("", workspace);
      const result = await run(["-p", "say hi", "--agent", "greeter", "--kernel", kernel], cap.streams);
      const session = Object.values((await daemon.project(workspace)).sessions)[0];
      const turn = [...(session?.root.liveTurns ?? [])].find((node) => node.evalSpec != null);
      expect({
        code: result.code,
        stdout: cap.stdout,
        expr: evalProgramOf(turn!)?.expr,
      }).toEqual({
        code: 1,
        stdout: "",
        expr: '(bot/send \'greeter "say hi")',
      });
    },
    TIMEOUT,
  );

  it(
    "reconnects mid-flight to the same program and does not admit another",
    async () => {
      const { kernel, workspace } = await openWorld();
      execFileSync("mkfifo", [join(workspace, "hang.fifo")]);
      const client = await Client.start(kernel, workspace);
      const admitted = (await client.request("eval", {
        requestId: "req-mid",
        expr: '(read_file "hang.fifo")',
        policy: "yolo",
      })) as { ok: true; turnId: string; programId: string };
      await when(() => evalProgramOf(findEvalTurnByRequestId(client.sessionRoot, "req-mid")!) != null, {
        timeout: TIMEOUT,
      });
      const sessionId = client.sessionId;
      await client[Symbol.asyncDispose]();
      const again = await Client.connect(kernel, workspace, sessionId);
      onTestFinished(async () => {
        await again[Symbol.asyncDispose]();
      });
      const turn = findEvalTurnByRequestId(again.sessionRoot, "req-mid");
      const program = evalProgramOf(turn!);
      const reused = (await again.request("eval", {
        requestId: "req-mid",
        expr: '(read_file "hang.fifo")',
        policy: "yolo",
      })) as { ok: true; turnId: string; programId: string };
      expect({
        completed: program?.completed ?? true,
        programId: program?.uuid,
        reused,
      }).toEqual({
        completed: false,
        programId: admitted.programId,
        reused: { ok: true, turnId: admitted.turnId, programId: admitted.programId },
      });
      await again.request("turn/cancel", { requestId: "req-mid" });
    },
    TIMEOUT,
  );
});
