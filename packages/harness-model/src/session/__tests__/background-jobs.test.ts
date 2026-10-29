import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { autorun } from "mobx";
import { beforeEach, describe, expect, it } from "vitest";

import { liveBackgroundJobs, liveJobsCheckIn, programKind } from "../background-jobs.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { programKindNow } from "../program-kind.js";
import { SCHEME_WATCH_TOOL_NAME } from "../scheme-syntax.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";
import { attached } from "./_helpers/fixtures.js";

describe("background jobs", () => {
  beforeEach(() => resetLocalIDs());

  it("classifies every host call, and leaves the job unsettled until the reader finishes", async () => {
    const shellExpr = '(shell "echo hi")';
    const shell = new ProgrammaticJob({ argsJson: JSON.stringify({ expr: shellExpr }) });
    const watch = new ProgrammaticJob({
      toolName: SCHEME_WATCH_TOOL_NAME,
      argsJson: JSON.stringify({ expr: shellExpr }),
    });
    expect({ unsettled: shell.kind, watch: watch.kind }).toEqual({ unsettled: "workflow", watch: "workflow" });
    expect({
      shell: await programKind(shellExpr),
      agent: await programKind('(agent/ask \'explore "map the repo")'),
      bot: await programKind('(bot/send "x")'),
      two: await programKind('(shell "a") (shell "b")'),
      nested: await programKind('(begin (shell "a"))'),
      agents: await programKind('(begin (agent/ask \'a "1") (agent/ask \'b "2"))'),
      mixed: await programKind('(begin (shell "a") (agent/ask \'explore "x"))'),
      tool: await programKind('(read_file "a")'),
      helper: await programKind("(meta-reactivity/done-condition #f)"),
      pure: await programKind('(agent/ask \'x (string-append "a" (number->string (+ 1 2))))'),
      mapped: await programKind('(map (lambda (p) (shell p)) (list "a" "b"))'),
      accessor: await programKind("(bot/send (cadr '(1 2)))"),
      quoted: await programKind('(shell "echo (hi)")'),
      data: await programKind("'(agent/ask 'e \"x\")"),
      shadow: await programKind("(let ((shell (lambda () 1))) (shell))"),
      unquote: await programKind('`(no ,(bot/send "x"))'),
      datum: await programKind('(case 1 (((shell "a")) (bot/send "x")))'),
      arms: await programKind('(if #t (bot/send "x") (shell "y"))'),
      stringHead: await programKind('("shell" "hi")'),
      defined: await programKind('(define (go) (bot/send "x")) (go)'),
      vector: await programKind('[(shell "a")]'),
      constant: await programKind('#((shell "a"))'),
      seq: await programKind('(let* ((a (shell "a")) (b (bot/send a))) b)'),
      broken: await programKind("("),
      job: shell.kind,
      watch: watch.kind,
    }).toEqual({
      shell: "command",
      agent: "agent",
      bot: "bot",
      two: "command",
      nested: "command",
      agents: "agent",
      mixed: "workflow",
      tool: "command",
      helper: "workflow",
      pure: "agent",
      mapped: "command",
      accessor: "bot",
      quoted: "command",
      data: "workflow",
      shadow: "workflow",
      unquote: "bot",
      datum: "bot",
      arms: "workflow",
      stringHead: "workflow",
      defined: "bot",
      vector: "command",
      constant: "workflow",
      seq: "workflow",
      broken: "workflow",
      job: "command",
      watch: "workflow",
    });
  });

  it("tells an observer when a program's kind settles", async () => {
    const expr = '(bot/send "observed")';
    const job = new ProgrammaticJob({ argsJson: JSON.stringify({ expr }) });
    const seen: string[] = [];
    const stop = autorun(() => seen.push(job.kind));
    await programKind(expr);
    stop();
    expect(seen).toEqual(["workflow", "bot"]);
  });

  it("forgets old decisions instead of growing without bound", async () => {
    const first = '(shell "first")';
    await programKind(first);
    expect(programKindNow(first)).toBe("command");
    for (let index = 0; index < 1024; index++) await programKind(`(shell "${index}")`);
    expect(programKindNow(first)).toBe("workflow");
  });

  it("lists a live background program", async () => {
    const session = attached({ sessionId: "s-jobs", path: "/tmp/j" });
    const plexus = Plexus.bootstrap(session);
    const bag = new ProgrammaticJob({
      toolCallId: "job-scheme",
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr: '(begin (shell "a") (agent/ask \'explore "x"))' }),
      background: true,
      outcomeJson: JSON.stringify({ ok: true, value: { job_id: "job-scheme", background: true } }),
    });
    const shell = new SystemToolJob({
      toolCallId: "job-shell",
      name: "shell",
      argsJson: JSON.stringify({ command: "npm run dev" }),
      background: true,
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [bag, shell],
      reducerExited: true,
    });
    turn.pushChild(bag);
    turn.pushChild(shell);
    session.head = turn;

    const listed = await liveBackgroundJobs(session.motionWork());
    const card = liveJobsCheckIn(listed);

    expect({
      listed,
      card,
    }).toEqual({
      listed: [
        { jobId: "job-scheme", kind: "workflow", object: '(begin (shell "a") (agent/ask \'explore "x"))' },
        { jobId: "job-shell", kind: "command", object: "npm run dev" },
      ],
      card: 'background jobs:\njob-scheme workflow (begin (shell "a") (agent/ask \'explore "x"))\njob-shell command npm run dev',
    });
    plexus.destroy();
  });

  it("lists scheme_watch without the flag and skips a background write", async () => {
    const watch = new ProgrammaticJob({
      toolCallId: "job-watch",
      toolName: SCHEME_WATCH_TOOL_NAME,
      argsJson: JSON.stringify({ expr: '(shell "a")' }),
    });
    const write = new SystemToolJob({
      toolCallId: "job-write",
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.ts" }),
      background: true,
    });
    expect(await liveBackgroundJobs([watch, write])).toEqual([
      { jobId: "job-watch", kind: "workflow", object: '(shell "a")' },
    ]);
  });
});
