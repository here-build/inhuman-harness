/**
 * license is the guard. Tests stand up a Job orchestrator and wait
 * orchestrationResult — not an isolated classify call. Programs live
 * on the session root. Floor join runs under cap 1.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  AgentCallbackJob,
  AgentMessageJob,
  AgentNotifyJob,
  CompletionExpectation,
  MCPToolJob,
  McpToolExpectation,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { observable, runInAction, when } from "mobx";
import { describe, expect, it } from "vitest";

import { license } from "../license.js";
import { scopes } from "../scope.js";
import { read, settled, shell, TIMEOUT, write } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const distAsk = readFileSync(join(here, "../../../policy/auto-mode-ask.scm"), "utf8");

const FLOOR = `{"read_file":["."],"write_file":["."],"read_block":[".env"],"write_block":[".env"],"bash":{"policy":"ask","subcommands":{"rm":"deny","ls":"approve","curl":"ask"}}}`;

describe("license", () => {
  it("orchestrator floor join", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, cap: 1 });
    const rows = [
      { job: shell("ls"), out: true, policyResult: "policyApprove" },
      { job: write(".env"), out: false, policyResult: "block" },
      { job: read(".env"), out: false, policyResult: "block" },
      {
        job: new AgentCallJob({ toolCallId: "call", name: "agent__send", argsJson: '{"spec":"echo","message":"hi"}' }),
        out: true,
        policyResult: null,
      },
      {
        job: new AgentMessageJob({
          toolCallId: "msg",
          name: "agent__message",
          argsJson: '{"targetName":"echo","message":"hi"}',
        }),
        out: true,
        policyResult: null,
      },
      { job: new AgentCallbackJob({ toolCallId: "cb", name: "agent__respond" }), out: true, policyResult: null },
      { job: new AgentNotifyJob({ toolCallId: "nt", name: "agent__notify" }), out: true, policyResult: null },
      {
        job: new SystemToolJob({
          triggersReactLoop: false,
          tapeHidden: true,
          isSideChannel: true,
          toolCallId: "md",
          name: "update_metadata",
          argsJson: JSON.stringify({ current_turn_title: "Fix login" }),
        }),
        out: true,
        policyResult: null,
      },
      {
        job: new SystemToolJob({
          toolCallId: "stop",
          name: "job_stop",
          argsJson: JSON.stringify({ job_id: "call_spawned" }),
        }),
        out: true,
        policyResult: null,
      },
      {
        job: new SystemToolJob({
          toolCallId: "tc",
          name: "task__create",
          isSideChannel: true,
          argsJson: JSON.stringify({
            subject: "A",
            description: "d",
            validationProgram: '(read_file "x")',
          }),
        }),
        out: true,
        policyResult: null,
      },
      {
        job: new SystemToolJob({
          toolCallId: "tv",
          name: "task__validate",
          isSideChannel: true,
          argsJson: JSON.stringify({ taskId: "id" }),
        }),
        out: true,
        policyResult: null,
      },
      {
        job: new SystemToolJob({
          toolCallId: "ws",
          name: "web_search",
          argsJson: JSON.stringify({ query: "tea" }),
        }),
        out: true,
        policyResult: "policyApprove",
      },
    ] as const;
    const edit = write("src/a.ts");
    const rm = shell("rm x");
    const offLoop = new SystemToolJob({
      toolCallId: "off",
      name: "note",
      argsJson: JSON.stringify({ text: "x" }),
      triggersReactLoop: false,
    });
    for (const row of rows) bag.enqueue(row.job);
    bag.enqueue(edit);
    bag.enqueue(rm);
    bag.enqueue(offLoop);
    await Promise.all(rows.map((row) => settled(row.job)));
    await when(() => edit.policyResult === "ask" && rm.policyResult === "deny" && offLoop.policyResult === "ask", {
      timeout: TIMEOUT,
    });

    using yolo = setup({ policy: "yolo", policyProgram: FLOOR });
    const allowed = shell("curl x");
    const yoloDeny = shell("rm x");
    const blocked = write(".env");
    yolo.enqueue(allowed);
    yolo.enqueue(yoloDeny);
    yolo.enqueue(blocked);
    await Promise.all([settled(allowed), settled(yoloDeny), settled(blocked)]);

    using thrown = setup({ policy: "manual", policyProgram: "(" });
    const ls = shell("ls");
    thrown.enqueue(ls);
    await when(() => ls.policyResult !== null, { timeout: TIMEOUT });
    await settled(ls);

    expect({
      floor: rows.map((row) => ({
        policyResult: row.job.policyResult,
        orchestrationResult: row.job.orchestrationResult,
        humanApprove: row.job.humanApprove,
      })),
      yolo: {
        ask: { policyResult: allowed.policyResult, orchestrationResult: allowed.orchestrationResult },
        deny: { policyResult: yoloDeny.policyResult, orchestrationResult: yoloDeny.orchestrationResult },
        block: { policyResult: blocked.policyResult, orchestrationResult: blocked.orchestrationResult },
      },
      operatorThrow: { policyResult: ls.policyResult, orchestrated: ls.orchestrated },
      edit: { policyResult: edit.policyResult, orchestrated: edit.orchestrated, humanApprove: edit.humanApprove },
      rm: { policyResult: rm.policyResult, orchestrated: rm.orchestrated, humanApprove: rm.humanApprove },
      offLoop: { policyResult: offLoop.policyResult, orchestrated: offLoop.orchestrated },
    }).toEqual({
      floor: rows.map((row) => ({
        policyResult: row.policyResult,
        orchestrationResult: row.out,
        humanApprove: null,
      })),
      yolo: {
        ask: { policyResult: "ask", orchestrationResult: true },
        deny: { policyResult: "deny", orchestrationResult: true },
        block: { policyResult: "block", orchestrationResult: false },
      },
      // a broken operator policy fails closed to block (an ask would be lifted by a standing grant)
      operatorThrow: { policyResult: "block", orchestrated: true },
      edit: { policyResult: "ask", orchestrated: false, humanApprove: null },
      rm: { policyResult: "deny", orchestrated: false, humanApprove: null },
      offLoop: { policyResult: "ask", orchestrated: false },
    });
  });

  it("mcp persist floor denies a blocked name without writing approved", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR });
    scopes.get(bag.root).mcpPersistDenies = (job) => job instanceof MCPToolJob && job.serverToolName === "merge";
    const mcp = new MCPToolJob({
      toolCallId: "persist-deny",
      name: "mcp__mail__merge",
      connectionKey: "mail",
      serverToolName: "merge",
      argsJson: "{}",
      expectation: new McpToolExpectation({
        connectionId: "mail",
        serverToolName: "merge",
        argsJson: "{}",
      }),
    });
    bag.enqueue(mcp);
    await when(() => mcp.policyResult === "deny", { timeout: TIMEOUT });
    expect({
      policyResult: mcp.policyResult,
      humanApprove: mcp.humanApprove,
      orchestrationResult: mcp.orchestrationResult,
    }).toEqual({ policyResult: "deny", humanApprove: null, orchestrationResult: null });
  });

  it("a human allow of an outside read licenses that call only; a session root is the explicit way", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR });
    const first = read("/tmp/outside.txt");
    const again = read("/tmp/outside.txt");
    bag.enqueue(first);
    await when(() => first.policyResult === "deny", { timeout: TIMEOUT });
    first.humanApprove = true;
    await settled(first);
    bag.enqueue(again);
    await when(() => again.policyResult === "deny", { timeout: TIMEOUT });
    expect({
      first: { humanApprove: first.humanApprove, orchestrationResult: first.orchestrationResult },
      again: { policyResult: again.policyResult, needsHuman: again.needsHuman, orchestrated: again.orchestrated },
      roots: Object.keys(bag.root.readRoots),
    }).toEqual({
      first: { humanApprove: true, orchestrationResult: true },
      again: { policyResult: "deny", needsHuman: true, orchestrated: false },
      roots: [],
    });
    expect(bag.root.addReadRoot("/tmp/other")).toBe(true);
    const child = read("/tmp/other/a.ts");
    const other = read("/etc/passwd");
    bag.enqueue(child);
    bag.enqueue(other);
    await settled(child);
    await when(() => other.policyResult === "deny", { timeout: TIMEOUT });
    expect({
      child: { humanApprove: child.humanApprove, policyResult: child.policyResult, ran: child.orchestrationResult },
      other: { policyResult: other.policyResult, orchestrated: other.orchestrated },
    }).toEqual({
      child: { humanApprove: null, policyResult: "policyApprove", ran: true },
      other: { policyResult: "deny", orchestrated: false },
    });
  });

  it("shell extra-root cwd is remainder; in-root is silent; a fenced folder cannot be a root", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR });
    expect(bag.root.addReadRoot("/etc")).toBe(false);
    const inRoot = shell("ls", "./src");
    const extraAbs = shell("ls", "/etc");
    const extraRel = shell("ls", "../bin");
    const omitted = shell("ls");
    bag.enqueue(inRoot);
    bag.enqueue(extraAbs);
    bag.enqueue(extraRel);
    bag.enqueue(omitted);
    await Promise.all([settled(inRoot), settled(omitted)]);
    await when(() => extraAbs.policyResult === "deny" && extraRel.policyResult === "deny", { timeout: TIMEOUT });
    expect({
      inRoot: { policyResult: inRoot.policyResult, orchestrationResult: inRoot.orchestrationResult },
      omitted: { policyResult: omitted.policyResult, orchestrationResult: omitted.orchestrationResult },
      extraAbs: {
        policyResult: extraAbs.policyResult,
        orchestrated: extraAbs.orchestrated,
        humanApprove: extraAbs.humanApprove,
      },
      extraRel: {
        policyResult: extraRel.policyResult,
        orchestrated: extraRel.orchestrated,
        humanApprove: extraRel.humanApprove,
      },
    }).toEqual({
      inRoot: { policyResult: "policyApprove", orchestrationResult: true },
      omitted: { policyResult: "policyApprove", orchestrationResult: true },
      extraAbs: { policyResult: "deny", orchestrated: false, humanApprove: null },
      extraRel: { policyResult: "deny", orchestrated: false, humanApprove: null },
    });
  });

  it("mcp persist floor allows a stem without writing approved", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR });
    scopes.get(bag.root).mcpPersistAllows = (job) => job instanceof MCPToolJob && job.serverToolName === "search";
    const mcp = new MCPToolJob({
      toolCallId: "persist",
      name: "mcp__mail__search",
      connectionKey: "mail",
      serverToolName: "search",
      argsJson: "{}",
      expectation: new McpToolExpectation({
        connectionId: "mail",
        serverToolName: "search",
        argsJson: "{}",
      }),
    });
    bag.enqueue(mcp);
    await settled(mcp);
    expect({
      policyResult: mcp.policyResult,
      humanApprove: mcp.humanApprove,
      orchestrationResult: mcp.orchestrationResult,
    }).toEqual({ policyResult: "policyApprove", humanApprove: null, orchestrationResult: true });
  });

  it("wait lifecycle", async () => {
    const residual = await (async () => {
      using deny = setup({
        policy: "auto",
        unattended: false,
        policyProgram: FLOOR,
        judgeAskProgram: "stub",
        privileged: "remove x",
        backoffMs: () => 0,
      });
      const rm = shell("rm x");
      deny.enqueue(rm);
      await when(() => rm.classifierAbstain !== null, { timeout: TIMEOUT });
      const denySnap = {
        policyResult: rm.policyResult,
        classifierResult: rm.classifierResult,
        orchestrationResult: rm.orchestrationResult,
        fail: rm.classifierAbstain,
      };

      using ask = setup({ policy: "auto", policyProgram: FLOOR, judgeAskProgram: "stub", backoffMs: () => 0 });
      const curl = shell("curl x");
      const mcp = new MCPToolJob({
        toolCallId: "mcp",
        name: "mcp__mail__search",
        argsJson: "{}",
        expectation: new McpToolExpectation({ connectionId: "mcp", argsJson: "{}" }),
      });
      ask.enqueue(curl);
      ask.enqueue(mcp);
      await when(() => curl.classifierAbstain !== null && mcp.classifierAbstain !== null, { timeout: TIMEOUT });
      const askFail = {
        curl: {
          policyResult: curl.policyResult,
          classifierResult: curl.classifierResult,
          fail: curl.classifierAbstain,
          orchestrated: curl.orchestrated,
        },
        mcp: {
          policyResult: mcp.policyResult,
          classifierResult: mcp.classifierResult,
          fail: mcp.classifierAbstain,
          orchestrated: mcp.orchestrated,
        },
      };
      curl.humanApprove = true;
      mcp.humanApprove = false;
      await Promise.all([settled(curl), settled(mcp)]);
      return {
        deny: denySnap,
        askFail,
        human: { curl: curl.orchestrationResult, mcp: mcp.orchestrationResult },
      };
    })();

    const liveSwitch = await (async () => {
      using live = setup({ policy: "manual", policyProgram: FLOOR });
      const waiting = shell("curl x");
      live.enqueue(waiting);
      await when(() => waiting.policyResult === "ask", { timeout: TIMEOUT });
      const pending = waiting.orchestrated;
      live.root.permissionMode = "yolo";
      await settled(waiting);
      return { pending, after: waiting.orchestrationResult };
    })();

    const stamp = await (async () => {
      using bag = setup({
        policy: "auto",
        unattended: false,
        policyProgram: "",
        judgeAskProgram: "",
        backoffMs: () => 0,
      });
      const ls = shell("ls");
      const curl = shell("curl x");
      bag.enqueue(ls);
      bag.enqueue(curl);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      const pending = { ls: ls.policyResult, curl: curl.policyResult, orchestrated: ls.orchestrated };
      bag.root.policyProgram = FLOOR;
      await when(() => ls.orchestrated && curl.policyResult === "ask", { timeout: TIMEOUT });
      const floored = {
        ls: ls.orchestrationResult,
        curl: {
          policyResult: curl.policyResult,
          classifierResult: curl.classifierResult,
          orchestrated: curl.orchestrated,
        },
      };
      bag.root.kvs.connection = "c1";
      bag.root.kvs.model = "m";
      bag.root.judgeAskProgram = "allow";
      await settled(curl);
      return {
        pending,
        floored,
        judged: { classifierResult: curl.classifierResult, orchestrationResult: curl.orchestrationResult },
      };
    })();

    const connection = await (async () => {
      const program = `(classifier/bash (lambda (command) "allow"))`;
      using bag = setup({
        policy: "auto",
        unattended: false,
        policyProgram: FLOOR,
        judgeAskProgram: program,
        backoffMs: () => 60_000,
      });
      const curl = shell("curl x");
      bag.enqueue(curl);
      await when(() => curl.classifierAbstain !== null, { timeout: TIMEOUT });
      const waiting = { classifierResult: curl.classifierResult, orchestrated: curl.orchestrated };
      bag.root.kvs.connection = "c1";
      bag.root.kvs.model = "m";
      await settled(curl);
      return {
        waiting,
        after: { classifierResult: curl.classifierResult, orchestrationResult: curl.orchestrationResult },
      };
    })();

    const leaveAuto = await (async () => {
      const program = `(classifier/bash (lambda (command) "allow"))`;
      using bag = setup({
        policy: "auto",
        unattended: false,
        policyProgram: FLOOR,
        judgeAskProgram: program,
        backoffMs: () => 60_000,
      });
      const curl = shell("curl x");
      bag.enqueue(curl);
      await when(() => curl.classifierAbstain !== null, { timeout: TIMEOUT });
      bag.root.permissionMode = "manual";
      const pending = curl.orchestrated;
      bag.root.permissionMode = "auto";
      bag.root.kvs.connection = "c1";
      bag.root.kvs.model = "m";
      await settled(curl);
      return {
        pending,
        after: { classifierResult: curl.classifierResult, orchestrationResult: curl.orchestrationResult },
      };
    })();

    const close = await (async () => {
      using bag = setup({ policy: "manual", policyProgram: FLOOR });
      const job = shell("curl x");
      const pending = license(job, bag.turn, bag.root);
      await when(() => job.policyResult === "ask", { timeout: TIMEOUT });
      runInAction(() => {
        job.humanApprove = true;
        scopes.get(bag.root).close();
      });
      return await pending;
    })();

    const modeClose = await (async () => {
      const held = observable.box<CompletionExpectation | undefined>(undefined);
      using bag = setup({
        policy: "auto",
        unattended: false,
        policyProgram: FLOOR,
        judgeAskProgram: distAsk,
        privileged: "user: go\ncall: shell curl x",
        backoffMs: () => 0,
        seal(completion) {
          runInAction(() => {
            if (held.get() === undefined) held.set(completion);
          });
        },
      });
      bag.root.kvs.connection = "c1";
      bag.root.kvs.model = "m";
      const curl = shell("curl x");
      bag.enqueue(curl);
      await when(() => held.get() !== undefined, { timeout: TIMEOUT });
      runInAction(() => {
        bag.root.permissionMode = "manual";
        scopes.get(bag.root).close();
      });
      const leaveAutoCompletion = held.get();
      if (leaveAutoCompletion == null) throw new Error("expected held completion");
      leaveAutoCompletion.succeed("settled", "", "null", {
        result: { text: JSON.stringify({ decision: "allow", risk: 2, authorization: 8, retrieve: "none" }) },
      });
      await settled(curl);
      return { classifierResult: curl.classifierResult, orchestrationResult: curl.orchestrationResult };
    })();

    const cleared = await (async () => {
      const held = observable.box<CompletionExpectation | undefined>(undefined);
      using bag = setup({
        policy: "auto",
        unattended: false,
        policyProgram: FLOOR,
        judgeAskProgram: distAsk,
        privileged: "user: go\ncall: shell curl x",
        backoffMs: () => 0,
        seal(completion) {
          runInAction(() => {
            if (held.get() !== undefined) return;
            held.set(completion);
          });
        },
      });
      bag.root.kvs.connection = "c1";
      bag.root.kvs.model = "m";
      const curl = shell("curl x");
      bag.enqueue(curl);
      await when(() => held.get() !== undefined, { timeout: TIMEOUT });
      bag.root.judgeAskProgram = "";
      const clearedCompletion = held.get();
      if (clearedCompletion == null) throw new Error("expected held completion");
      clearedCompletion.succeed("settled", "", "null", {
        result: { text: JSON.stringify({ decision: "allow", risk: 2, authorization: 8, retrieve: "none" }) },
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      return { classifierResult: curl.classifierResult, orchestrated: curl.orchestrated };
    })();

    expect({ residual, liveSwitch, stamp, connection, leaveAuto, close, modeClose, cleared }).toEqual({
      residual: {
        deny: {
          policyResult: "deny",
          classifierResult: null,
          orchestrationResult: null,
          fail: "no model connection",
        },
        askFail: {
          curl: { policyResult: "ask", classifierResult: null, fail: "no model connection", orchestrated: false },
          mcp: { policyResult: "ask", classifierResult: null, fail: "no model connection", orchestrated: false },
        },
        human: { curl: true, mcp: false },
      },
      liveSwitch: { pending: false, after: true },
      stamp: {
        pending: { ls: null, curl: null, orchestrated: false },
        floored: {
          ls: true,
          curl: { policyResult: "ask", classifierResult: null, orchestrated: false },
        },
        judged: { classifierResult: "allow", orchestrationResult: true },
      },
      connection: {
        waiting: { classifierResult: null, orchestrated: false },
        after: { classifierResult: "allow", orchestrationResult: true },
      },
      leaveAuto: {
        pending: false,
        after: { classifierResult: "allow", orchestrationResult: true },
      },
      close: true,
      modeClose: { classifierResult: null, orchestrationResult: false },
      cleared: { classifierResult: null, orchestrated: false },
    });
  }, 30_000);

  it("auto continue remainder classifies from tail user messages", async () => {
    using bag = setup({
      policy: "auto",
      unattended: false,
      policyProgram: FLOOR,
      judgeAskProgram: distAsk,
      privileged: "",
      backoffMs: () => 0,
      seal(completion) {
        completion.succeed("settled", "", "null", {
          result: { text: JSON.stringify({ decision: "allow", risk: 2, authorization: 8, retrieve: "none" }) },
        });
      },
    });
    bag.turn.turnTail = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`user: go
call: shell curl x`,
      queue: [],
    });
    bag.root.kvs.connection = "c1";
    bag.root.kvs.model = "m";
    const curl = shell("curl x");
    bag.enqueue(curl);
    await settled(curl);
    expect({
      classifierResult: curl.classifierResult,
      fail: curl.classifierAbstain,
      humanApprove: curl.humanApprove,
    }).toEqual({
      classifierResult: "allow",
      fail: null,
      humanApprove: null,
    });
  }, 15_000);
});
