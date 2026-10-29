import { tmpdir } from "node:os";
import { join } from "node:path";

import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  BotCallJob,
  AgentCallbackJob,
  AgentMessageJob,
  AgentNotifyJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import { mkdir, mkdtemp, readFile, remove, writeFile, writeJson } from "fs-extra";
import { runInAction, when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { license } from "@/policy-processor/license";
import { scopes } from "@/policy-processor/scope";
import { distPolicySource, loadPolicySource } from "@/tool-runtime";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 8_000;

const BASH_DENY = `{"bash":{"policy":"ask","subcommands":{"rm":"deny"}}}`;

const ECHO_ASK = `{"bash":{"policy":"ask","subcommands":{"echo":"ask"}}}`;

function tool(name: string, argsJson = "{}"): { call: SystemToolJob; leaf: SystemToolJob } {
  const job = new SystemToolJob({
    toolCallId: `c-${Math.random().toString(16).slice(2)}`,
    name,
    argsJson,
  });
  return { call: job, leaf: job };
}

async function play(leaf: ToolCallJob, opts: { program?: string; workspace?: string } = {}): Promise<string | null> {
  const workspace = opts.workspace ?? (await mkdtemp(join(tmpdir(), "harness-approval-floor-")));
  const owned = opts.workspace === undefined;
  const root = new SessionRoot({
    sessionId: "s-approve",
    path: workspace,
    policyProgram: opts.program ?? distPolicySource(),
  });
  const plexus = Plexus.bootstrap(root);
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`play`,
    queue: [],
  });
  root.head = turn;
  const scope = scopes.get(root);
  let error: string | null = null;
  scope.onPolicyError = (text) => {
    error = text;
  };
  try {
    if (leaf.commFirst) {
      await license(leaf, turn, root);
      return error;
    }
    scope.admit(leaf);
    await when(() => leaf.policyResult !== null, { timeout: TIMEOUT });
    return error;
  } finally {
    scope.release(leaf);
    scope.close();
    plexus.destroy();
    if (owned) await remove(workspace);
  }
}

async function openLive(): Promise<{ kernel: KernelDaemon; session: SessionDaemon }> {
  const system = await mkdtemp(join(tmpdir(), "harness-approve-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-approve-p-"));
  await writeJson(join(system, "config.json"), { connections: {} });
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { kernel, session };
}

function queuedTurn(pending: { call: SystemToolJob }, promptText: string, policy: "yolo" | "manual"): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`${promptText}`,
    queue: [pending.call],
    permissionMode: policy,
  });
}

async function parkTurn(session: SessionDaemon, turn: SessionTurn): Promise<void> {
  session.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`park`,
    queue: [],
    reducerExited: true,
  });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });
}

describe("session approve", () => {
  beforeEach(() => resetLocalIDs());

  it("license residual", async () => {
    const distRows: { name: string; args: string; out: "policyApprove" | "deny" | "ask" | "block" }[] = [
      { name: "read_file", args: '{"path":"a.ts"}', out: "policyApprove" },
      { name: "write_file", args: '{"path":"a.ts"}', out: "ask" },
      { name: "shell", args: '{"command":"echo hi"}', out: "policyApprove" },
      { name: "shell", args: '{"command":"curl x"}', out: "ask" },
      { name: "write_file", args: '{"path":".env"}', out: "block" },
      { name: "unknown_tool", args: "{}", out: "ask" },
      { name: "write_file", args: "{}", out: "ask" },
      { name: "shell", args: "{}", out: "ask" },
      { name: "read_file", args: "{", out: "ask" },
    ];
    const dist = [];
    for (const row of distRows) {
      const work = tool(row.name, row.args);
      await play(work.leaf, {});
      dist.push({ ...row, policyResult: work.leaf.policyResult, humanApprove: work.leaf.humanApprove });
    }

    const rm = tool("shell", '{"command":"rm x"}');
    await play(rm.leaf, { program: BASH_DENY });
    const destructive = tool("shell", '{"command":"rm -rf /"}');
    await play(destructive.leaf, { program: BASH_DENY });

    const call = new BotCallJob({ name: "agent__send", argsJson: '{"spec":"echo","message":"hi"}' });
    const message = new AgentMessageJob({ name: "agent__message", argsJson: '{"targetName":"echo","message":"hi"}' });
    const respond = new AgentCallbackJob({ name: "agent__respond", argsJson: '{"requestId":"x"}' });
    const notify = new AgentNotifyJob({ name: "agent__notify", argsJson: '{"requestId":"x","message":"n"}' });
    await play(call, {});
    await play(message, {});
    await play(respond, {});
    await play(notify, {});

    const write = tool("write_file", '{"path":"a.ts"}');
    await play(write.leaf, {});

    const allowed = tool("read_file", '{"path":"a.ts"}');
    await play(allowed.leaf, {});
    const env = tool("write_file", '{"path":".env"}');
    await play(env.leaf, {});
    const shellAuto = tool("shell", '{"command":"curl x"}');
    await play(shellAuto.leaf, {});
    const callback = new AgentCallbackJob({ name: "agent__respond", argsJson: '{"requestId":"x"}' });
    await play(callback, {});

    expect({
      dist,
      yoloProgram: {
        rm: {
          policyResult: rm.leaf.policyResult,
          humanApprove: rm.leaf.humanApprove,
          orchestrationResult: rm.leaf.orchestrationResult,
        },
        destructive: {
          policyResult: destructive.leaf.policyResult,
          tirith: JSON.parse(destructive.leaf.policyEvidenceJson!).tirith.action,
        },
      },
      comms: {
        call: { policyResult: call.policyResult, humanApprove: call.humanApprove },
        message: { policyResult: message.policyResult, humanApprove: message.humanApprove },
        respond: respond.policyResult,
        notify: notify.policyResult,
      },
      plan: { policyResult: write.leaf.policyResult, humanApprove: write.leaf.humanApprove },
      unattended: {
        allowed: {
          policyResult: allowed.leaf.policyResult,
          humanApprove: allowed.leaf.humanApprove,
          outcome: allowed.leaf.receiptJson,
        },
        env: { policyResult: env.leaf.policyResult, humanApprove: env.leaf.humanApprove },
        shell: { policyResult: shellAuto.leaf.policyResult, humanApprove: shellAuto.leaf.humanApprove },
        callback: callback.policyResult,
      },
    }).toEqual({
      dist: distRows.map((row) => ({ ...row, policyResult: row.out, humanApprove: null })),
      yoloProgram: {
        rm: { policyResult: "deny", humanApprove: null, orchestrationResult: null },
        destructive: { policyResult: "block", tirith: "block" },
      },
      comms: {
        call: { policyResult: null, humanApprove: null },
        message: { policyResult: null, humanApprove: null },
        respond: null,
        notify: null,
      },
      plan: { policyResult: "ask", humanApprove: null },
      unattended: {
        allowed: { policyResult: "policyApprove", humanApprove: null, outcome: null },
        env: { policyResult: "block", humanApprove: null },
        shell: { policyResult: "ask", humanApprove: null },
        callback: null,
      },
    });

    const { session } = await openLive();
    const workspace = session.root.path;
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "hello.txt"), "hello-from-disk");

    session.root.mode = "act";
    session.root.standingPermissionMode = "yolo";
    const yoloBody = tool("read_file", '{"path":"hello.txt"}');
    const yoloBodyTurn = queuedTurn(yoloBody, "yolo-read", "yolo");
    session.root.head = yoloBodyTurn;
    await when(() => yoloBody.leaf.completed && yoloBody.call.receiptJson != null, { timeout: TIMEOUT });
    const yoloBodyOracle = {
      humanApprove: yoloBody.leaf.humanApprove,
      policyResult: yoloBody.leaf.policyResult,
      completed: yoloBody.leaf.completed,
      orchestrated: yoloBody.leaf.orchestrated,
      outcomeJson: yoloBody.call.receiptJson,
    };
    await parkTurn(session, yoloBodyTurn);

    session.root.policyProgram = BASH_DENY;
    const yoloDeny = tool("shell", '{"command":"rm x"}');
    const yoloDenyTurn = queuedTurn(yoloDeny, "yolo-deny", "yolo");
    session.root.head = yoloDenyTurn;
    await when(() => yoloDeny.leaf.completed, { timeout: TIMEOUT });
    const yoloDenyOracle = {
      humanApprove: yoloDeny.leaf.humanApprove,
      policyResult: yoloDeny.leaf.policyResult,
      orchestrationResult: yoloDeny.leaf.orchestrationResult,
    };
    await parkTurn(session, yoloDenyTurn);

    session.root.policyProgram = ECHO_ASK;
    const yoloAsk = tool("shell", '{"command":"echo hijack"}');
    const yoloAskTurn = queuedTurn(yoloAsk, "yolo-ask", "yolo");
    session.root.head = yoloAskTurn;
    await when(() => yoloAsk.leaf.completed, { timeout: TIMEOUT });
    const yoloAskOracle = {
      humanApprove: yoloAsk.leaf.humanApprove,
      policyResult: yoloAsk.leaf.policyResult,
      orchestrationResult: yoloAsk.leaf.orchestrationResult,
      outcomeOk: JSON.parse(yoloAsk.call.receiptJson ?? "{}").ok,
    };
    await parkTurn(session, yoloAskTurn);

    expect({ body: yoloBodyOracle, deny: yoloDenyOracle, ask: yoloAskOracle }).toEqual({
      body: {
        humanApprove: null,
        policyResult: "policyApprove",
        completed: true,
        orchestrated: true,
        outcomeJson: JSON.stringify({ ok: true, text: "hello-from-disk" }),
      },
      deny: { humanApprove: null, policyResult: "deny", orchestrationResult: true },
      ask: { humanApprove: null, policyResult: "ask", orchestrationResult: true, outcomeOk: true },
    });

    session.root.standingPermissionMode = "manual";
    session.root.policyProgram = distPolicySource();

    const humanAllow = tool("write_file", JSON.stringify({ path: "out.ts", content: "hi\n" }));
    const humanAllowTurn = queuedTurn(humanAllow, "write it", "manual");
    session.root.head = humanAllowTurn;
    await when(() => humanAllow.leaf.policyResult === "ask", { timeout: TIMEOUT });
    humanAllow.leaf.humanApprove = true;
    await when(() => humanAllow.leaf.completed && humanAllow.call.receiptJson != null, { timeout: TIMEOUT });
    const humanAllowOracle = {
      humanApprove: humanAllow.leaf.humanApprove,
      orchestrationResult: humanAllow.leaf.orchestrationResult,
      outcome: JSON.parse(humanAllow.call.receiptJson ?? "{}"),
      file: await readFile(join(workspace, "out.ts"), "utf8"),
    };
    await parkTurn(session, humanAllowTurn);

    const humanRefuse = tool("shell", '{"command":"curl x"}');
    const humanRefuseTurn = queuedTurn(humanRefuse, "deny-me", "manual");
    session.root.head = humanRefuseTurn;
    await when(() => humanRefuse.leaf.policyResult === "ask", { timeout: TIMEOUT });
    humanRefuse.leaf.approvalComment = "use ripgrep";
    humanRefuse.leaf.humanApprove = false;
    await when(() => humanRefuse.leaf.completed, { timeout: TIMEOUT });
    const humanRefuseOracle = {
      humanApprove: humanRefuse.leaf.humanApprove,
      orchestrationResult: humanRefuse.leaf.orchestrationResult,
      outcome: JSON.parse(humanRefuse.call.receiptJson ?? "{}"),
    };

    expect({ allow: humanAllowOracle, refuse: humanRefuseOracle }).toEqual({
      allow: {
        humanApprove: true,
        orchestrationResult: true,
        outcome: { ok: true, text: "created out.ts (3 bytes)" },
        file: "hi\n",
      },
      refuse: {
        humanApprove: false,
        orchestrationResult: false,
        outcome: {
          ok: false,
          text: "User refused this tool use",
          refusalReason: "User refused this tool use",
        },
      },
    });

    const asking = await openLive();
    const closeAsk = tool("write_file", JSON.stringify({ path: "nope.ts", content: "x\n" }));
    asking.session.root.head = queuedTurn(closeAsk, "write it", "manual");
    await when(() => closeAsk.leaf.policyResult === "ask", { timeout: TIMEOUT });
    scopes.get(asking.session.root).close();
    await when(() => closeAsk.leaf.completed || closeAsk.leaf.cancelled, { timeout: TIMEOUT });

    const allowedClose = await openLive();
    await mkdir(allowedClose.session.root.path, { recursive: true });
    const closeAllow = tool("write_file", JSON.stringify({ path: "kept.ts", content: "ok\n" }));
    allowedClose.session.root.head = queuedTurn(closeAllow, "write it", "manual");
    await when(() => closeAllow.leaf.policyResult === "ask", { timeout: TIMEOUT });
    runInAction(() => {
      closeAllow.leaf.humanApprove = true;
      scopes.get(allowedClose.session.root).close();
    });
    await when(() => closeAllow.leaf.completed && closeAllow.call.receiptJson != null, { timeout: TIMEOUT });

    expect({
      asking: {
        humanApprove: closeAsk.leaf.humanApprove,
        outcome: JSON.parse(closeAsk.call.receiptJson ?? "null"),
      },
      allowed: {
        outcome: JSON.parse(closeAllow.call.receiptJson ?? "{}"),
        file: await readFile(join(allowedClose.session.root.path, "kept.ts"), "utf8"),
      },
    }).toEqual({
      asking: { humanApprove: null, outcome: { ok: false, text: "cancelled" } },
      allowed: { outcome: { ok: true, text: "created kept.ts (3 bytes)" }, file: "ok\n" },
    });
  }, 60_000);

  it("loadPolicySource prefers kernel policy.json; unloadable operator fails closed (block)", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-policy-src-"));
    try {
      const missing = loadPolicySource(root);
      await writeFile(join(root, "policy.json"), "   \n");
      const blank = loadPolicySource(root);
      await writeFile(join(root, "policy.json"), '{"read_file":[]}\n');
      const operator = loadPolicySource(root);
      const boom = tool("read_file", '{"path":"a.ts"}');
      const boomErr = await play(boom.leaf, { program: "(" });
      const dist = distPolicySource();
      expect({
        missing,
        blank,
        operator,
        unloadable: { policyResult: boom.leaf.policyResult, error: boomErr !== null },
      }).toEqual({
        missing: dist,
        blank: dist,
        operator: '{"read_file":[]}\n',
        unloadable: { policyResult: "block", error: true },
      });
    } finally {
      await remove(root);
    }
  });

  it("file questions resolve from session cwd; glob cwd is the search root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "harness-approval-cwd-"));
    try {
      const rows: { name: string; args: Record<string, unknown>; out: "policyApprove" | "deny" | "ask" | "block" }[] = [
        { name: "glob", args: { pattern: "**/README.md" }, out: "policyApprove" },
        { name: "glob", args: { pattern: "**/README.md", cwd: workspace }, out: "policyApprove" },
        { name: "glob", args: { pattern: "**/README.md", path: workspace }, out: "policyApprove" },
        { name: "glob", args: { pattern: "**/*.md", cwd: "src" }, out: "policyApprove" },
        { name: "fff_search", args: { query: "readme", cwd: workspace }, out: "policyApprove" },
        { name: "read_file", args: { path: join(workspace, "a.ts") }, out: "policyApprove" },
        { name: "write_file", args: { path: join(workspace, "a.ts") }, out: "ask" },
        { name: "read_file", args: { path: "src/../.env" }, out: "block" },
        { name: "glob", args: { pattern: "**/*", cwd: "/etc" }, out: "deny" },
      ];
      const got = [];
      for (const row of rows) {
        const work = tool(row.name, JSON.stringify(row.args));
        await play(work.leaf, { workspace });
        got.push({ name: row.name, args: row.args, out: work.leaf.policyResult });
      }
      expect(got).toEqual(rows.map((row) => ({ name: row.name, args: row.args, out: row.out })));
    } finally {
      await remove(workspace);
    }
  });
});
