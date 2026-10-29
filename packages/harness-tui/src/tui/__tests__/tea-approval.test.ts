/** Ask cover writes `approved` on approvalHead. No approval RPC. */

import { prompt } from "@inhuman.tools/harness-commons";
import {
  KernelPlexus,
  KernelRoot,
  SessionPlexus,
  AgentCallJob,
  BotCallJob,
  AskAgentSpec,
  type AgentNature,
  SessionOverview,
  mcpToolRefKey,
  parseGrantRows,
  MCPToolJob,
  McpToolExpectation,
  SessionSystemPrompt,
  SessionTurn,
  SessionTurnEvalSpec,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import type { DecodedKeyEvent } from "@inhuman.tools/quickdraw/runtime";
import { expect, test } from "vitest";

import { answerLikeDaemon } from "./answer-door.js";
import { askAnnotation, Tea } from "../tea.js";

function localClient(): Client {
  const client = new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot({ approvalAskThrottleMs: 0 })),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
  client.request = async (method, params) => {
    answerLikeDaemon(client, method, params);
    return { ok: true };
  };
  return client;
}

function askTurn(id = "call_1"): { turn: SessionTurn; leaf: SystemToolJob; call: SystemToolJob } {
  const call = new SystemToolJob({
    toolCallId: id,
    name: "edit_file",
    argsJson: '{"path":"a.ts"}',
    policyResult: "ask",
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`edit it`,
    doneWork: [call],
    queue: [],
  });
  turn.pushChild(call);
  return { turn, leaf: call, call };
}

/** An ask the daemon would let a human remember (a path family); `tier` "deny" makes it a soft-deny. */
function rememberAsk(
  id = "call_1",
  tier: "ask" | "deny" = "ask",
): { turn: SessionTurn; leaf: SystemToolJob; call: SystemToolJob } {
  const asked = askTurn(id);
  asked.call.stampPolicy(tier, null, null, {
    classesJson: JSON.stringify(["workspace-write"]),
    votesJson: JSON.stringify([
      {
        disposition: tier,
        class: "workspace-write",
        ruleId: "write_file:.",
        path: { cluster: "write", path: "src/a.ts" },
      },
    ]),
  });
  return asked;
}

function press(tea: Tea, key: string, mods: Omit<DecodedKeyEvent, "key"> = {}): void {
  tea.handle({ kind: "input_events", events: [{ key, ...mods }] });
}

function mcpAsk(name = "get_issue"): { turn: SessionTurn; leaf: MCPToolJob } {
  const call = new MCPToolJob({
    toolCallId: "mcp_1",
    name: `mcp__github__${name}`,
    connectionKey: "github",
    serverToolName: name,
    argsJson: "{}",
    policyResult: "ask",
    expectation: new McpToolExpectation({
      connectionId: "github",
      serverToolName: name,
      argsJson: "{}",
    }),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`look it up`,
    doneWork: [call],
    queue: [],
  });
  turn.pushChild(call);
  return { turn, leaf: call };
}

function typeText(tea: Tea, text: string): void {
  tea.handle({ kind: "input_events", events: [...text].map((key) => ({ key })) });
}

function extraRead(path: string, id: string): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name: "read_file",
    argsJson: JSON.stringify({ path }),
    policyResult: "deny",
  });
}

function autoResidual(
  id: string,
  opts?: { readonly fail?: string; readonly name?: string; readonly argsJson?: string },
): { turn: SessionTurn; leaf: SystemToolJob } {
  const call = new SystemToolJob({
    toolCallId: id,
    name: opts?.name ?? "edit_file",
    argsJson: opts?.argsJson ?? '{"path":"a.ts"}',
    policyResult: "ask",
    ...(opts?.fail !== undefined ? { classifierAbstain: opts.fail } : {}),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user``,
    evalSpec: new SessionTurnEvalSpec({ requestId: `req-${id}`, permissionMode: "auto" }),
    permissionMode: "auto",
    doneWork: [call],
    queue: [],
  });
  turn.pushChild(call);
  return { turn, leaf: call };
}

test.each([
  {
    name: "empty-cover Enter allows a floor-deny head",
    play: () => {
      const client = localClient();
      const call = new SystemToolJob({
        toolCallId: "deny-cover",
        name: "shell",
        argsJson: '{"command":"rm file"}',
        policyResult: "deny",
      });
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`remove it`,
        doneWork: [call],
        queue: [],
      });
      turn.pushChild(call);
      client.sessionRoot.head = turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter");
      return { calls: [], draft: tea.draft.draft, humanApprove: call.humanApprove };
    },
    expected: { calls: [], draft: "", humanApprove: true },
  },
  {
    name: "empty-cover Enter allows the queue head",
    play: () => {
      const client = localClient();
      const asked = askTurn("allow");
      client.sessionRoot.head = asked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter");
      return {
        calls: [],
        draft: tea.draft.draft,
        humanApprove: asked.leaf.humanApprove,
        comment: asked.leaf.approvalComment,
      };
    },
    expected: { calls: [], draft: "", humanApprove: true, comment: null },
  },
  {
    name: "empty-cover Esc denies the queue head",
    play: () => {
      const client = localClient();
      const asked = askTurn("deny");
      client.sessionRoot.head = asked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Escape");
      return {
        calls: [],
        draft: tea.draft.draft,
        humanApprove: asked.leaf.humanApprove,
        comment: asked.leaf.approvalComment,
      };
    },
    expected: { calls: [], draft: "", humanApprove: false, comment: null },
  },
  {
    name: "first-ask throttle keeps Enter inert over a nonempty draft",
    play: () => {
      let now = 1_000;
      const client = localClient();
      client.kernelRoot.approvalAskThrottleMs = 2_000;
      const asked = askTurn();
      using tea = new Tea(client, () => undefined, { now: () => now });
      typeText(tea, "halfway");
      client.sessionRoot.head = asked.turn;
      press(tea, "Enter");
      const inert = { approved: asked.leaf.humanApprove, draft: tea.draft.draft };
      now = 3_000;
      tea.handle({ kind: "input_events", events: [] });
      press(tea, "Enter");
      return {
        inert,
        after: { approved: asked.leaf.humanApprove, draft: tea.draft.draft },
      };
    },
    expected: {
      inert: { approved: null, draft: "halfway" },
      after: { approved: true, draft: "halfway" },
    },
  },
  {
    name: "y n a Space do not grant; nonempty cover needs Ctrl+Enter",
    play: () => {
      const client = localClient();
      const asked = askTurn();
      client.sessionRoot.head = asked.turn;
      using tea = new Tea(client, () => undefined);
      for (const key of ["y", "n", "a", " "]) press(tea, key);
      const afterLetters = asked.leaf.humanApprove;
      press(tea, "Enter");
      press(tea, "Escape");
      press(tea, "Enter", { shift: true, alt: true });
      const afterBare = asked.leaf.humanApprove;
      press(tea, "Enter", { ctrl: true });
      return {
        afterLetters,
        afterBare,
        humanApprove: asked.leaf.humanApprove,
        comment: asked.leaf.approvalComment,
        draft: tea.draft.draft,
      };
    },
    expected: {
      afterLetters: null,
      afterBare: null,
      humanApprove: true,
      comment: "yna",
      draft: "",
    },
  },
  {
    name: "unattended auto residual without a fail message does not mount cover",
    play: () => {
      const client = localClient();
      const residual = autoResidual("u1", { name: "shell", argsJson: '{"command":"curl x"}' });
      client.sessionRoot.head = residual.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter");
      press(tea, "Escape");
      return { approved: residual.leaf.humanApprove, comment: residual.leaf.approvalComment };
    },
    expected: { approved: null, comment: null },
  },
  {
    name: "unattended auto residual never mounts the cover, even after a fail message",
    play: () => {
      const client = localClient();
      const residual = autoResidual("u2", { fail: "judge crashed" });
      client.sessionRoot.head = residual.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter");
      // nobody is there to answer: the run denies it as interaction_required instead
      return { approved: residual.leaf.humanApprove, needsHuman: residual.leaf.needsHuman };
    },
    expected: { approved: null, needsHuman: false },
  },
])("cover $name", ({ play, expected }) => {
  expect(play()).toEqual(expected);
});

test.each([
  {
    name: "remember session stores the daemon's offer as a session grant and no kernel RPC",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      const asked = rememberAsk();
      client.sessionRoot.head = asked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true });
      return {
        calls,
        draft: tea.draft.draft,
        humanApprove: asked.call.humanApprove,
        grants: parseGrantRows(client.sessionRoot.grantsJson).map((row) => [row.scope, row.expiresAtMs, row.subject]),
      };
    },
    expected: {
      calls: [],
      draft: "",
      humanApprove: true,
      grants: [["session", null, { kind: "path", cluster: "write", path: "src/a.ts", depth: "exact" }]],
    },
  },
  {
    name: "remember project sends a store and the grant lasts seven days",
    play: () => {
      const client = localClient();
      const sent: unknown[] = [];
      client.request = async (method, params) => {
        if (method === "ask/answer") sent.push(params);
        answerLikeDaemon(client, method, params);
        return { ok: true };
      };
      const asked = rememberAsk("call_always");
      client.sessionRoot.head = asked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true, shift: true });
      return {
        sent,
        humanApprove: asked.call.humanApprove,
        kernel: parseGrantRows(client.kernelRoot.grantsJson).map((row) => [row.scope, row.scopeKey, row.expiresAtMs]),
        session: client.sessionRoot.grantsJson,
      };
    },
    expected: {
      sent: [
        {
          sessionId: "s",
          jobId: expect.any(String),
          allow: true,
          store: { scope: "project", subject: { kind: "path", cluster: "write", path: "src/a.ts", depth: "exact" } },
        },
      ],
      humanApprove: true,
      kernel: [["project", "/tmp/p", 1_000_000 + 7 * 86_400_000]],
      session: "",
    },
  },
  {
    name: "a soft-deny shows no remember chord and Ctrl+Enter swallows",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      const asked = rememberAsk("soft", "deny");
      client.sessionRoot.head = asked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true });
      press(tea, "Enter", { ctrl: true, shift: true });
      return { calls, humanApprove: asked.call.humanApprove, offered: asked.call.grantOptions.length };
    },
    expected: { calls: [], humanApprove: null, offered: 0 },
  },
  {
    name: "a soft-deny Enter allows this call only and stores nothing",
    play: () => {
      const client = localClient();
      const asked = rememberAsk("soft2", "deny");
      client.sessionRoot.head = asked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter");
      return {
        humanApprove: asked.call.humanApprove,
        session: client.sessionRoot.grantsJson,
        kernel: client.kernelRoot.grantsJson,
      };
    },
    expected: { humanApprove: true, session: "", kernel: "" },
  },
  {
    name: "MCP remember session stores a session grant of server, account and tool",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      const looked = mcpAsk("get_issue");
      client.sessionRoot.head = looked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true });
      return {
        calls,
        draft: tea.draft.draft,
        humanApprove: looked.leaf.humanApprove,
        grants: parseGrantRows(client.sessionRoot.grantsJson).map((row) => row.subject),
        allow: client.sessionRoot.toolAllowlist[mcpToolRefKey("github", "get_issue")],
      };
    },
    expected: {
      calls: [],
      draft: "",
      humanApprove: true,
      grants: [{ kind: "mcp", server: "github", account: "github", tool: "get_issue" }],
      allow: undefined,
    },
  },
  {
    name: "MCP remember project stores a project grant",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      const looked = mcpAsk("get_issue");
      client.sessionRoot.head = looked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true, shift: true });
      return {
        calls,
        draft: tea.draft.draft,
        humanApprove: looked.leaf.humanApprove,
        kernel: parseGrantRows(client.kernelRoot.grantsJson).map((row) => [row.scope, row.subject]),
      };
    },
    expected: {
      calls: [],
      draft: "",
      humanApprove: true,
      kernel: [["project", { kind: "mcp", server: "github", account: "github", tool: "get_issue" }]],
    },
  },
  {
    name: "an MCP action offers the same remember chords as a look-up",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      const merge = mcpAsk("merge_pull_request");
      client.sessionRoot.head = merge.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true });
      return {
        calls,
        humanApprove: merge.leaf.humanApprove,
        grants: parseGrantRows(client.sessionRoot.grantsJson).map((row) => row.subject),
      };
    },
    expected: {
      calls: [],
      humanApprove: true,
      grants: [{ kind: "mcp", server: "github", account: "github", tool: "merge_pull_request" }],
    },
  },
  {
    name: "MCP deny-persist session blocklists the tool",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      const merge = mcpAsk("merge_pull_request");
      client.sessionRoot.head = merge.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Escape", { ctrl: true });
      return {
        calls,
        draft: tea.draft.draft,
        humanApprove: merge.leaf.humanApprove,
        block: client.sessionRoot.toolBlocklist[mcpToolRefKey("github", "merge_pull_request")],
      };
    },
    expected: { calls: [], draft: "", humanApprove: false, block: "session" },
  },
  {
    name: "MCP deny-persist always writes connect/exclude-tool",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      const merge = mcpAsk("merge_pull_request");
      client.sessionRoot.head = merge.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Escape", { ctrl: true, shift: true });
      return {
        calls,
        draft: tea.draft.draft,
        humanApprove: merge.leaf.humanApprove,
        block: client.sessionRoot.toolBlocklist[mcpToolRefKey("github", "merge_pull_request")],
      };
    },
    expected: {
      calls: [{ method: "connect/exclude-tool", params: { id: "github", tool: "merge_pull_request" } }],
      draft: "",
      humanApprove: false,
      block: "always",
    },
  },
  {
    name: "unpainted forever on a look-up swallows",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      const looked = mcpAsk("get_issue");
      client.sessionRoot.head = looked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Escape", { ctrl: true, shift: true });
      return {
        calls,
        draft: tea.draft.draft,
        humanApprove: looked.leaf.humanApprove,
        block: client.sessionRoot.toolBlocklist[mcpToolRefKey("github", "get_issue")],
      };
    },
    expected: { calls: [], draft: "", humanApprove: null, block: undefined },
  },
  {
    name: "comment allow does not write a persist list",
    play: () => {
      const client = localClient();
      const looked = mcpAsk("get_issue");
      client.sessionRoot.head = looked.turn;
      using tea = new Tea(client, () => undefined);
      typeText(tea, "because");
      press(tea, "Enter", { ctrl: true });
      return {
        calls: [],
        draft: tea.draft.draft,
        humanApprove: looked.leaf.humanApprove,
        comment: looked.leaf.approvalComment,
        allow: client.sessionRoot.toolAllowlist[mcpToolRefKey("github", "get_issue")],
      };
    },
    expected: { calls: [], draft: "", humanApprove: true, comment: "because", allow: undefined },
  },
  {
    name: "comment deny does not write a persist list",
    play: () => {
      const client = localClient();
      const merge = mcpAsk("merge_pull_request");
      client.sessionRoot.head = merge.turn;
      using tea = new Tea(client, () => undefined);
      typeText(tea, "no");
      press(tea, "Escape", { ctrl: true });
      return {
        calls: [],
        draft: tea.draft.draft,
        humanApprove: merge.leaf.humanApprove,
        comment: merge.leaf.approvalComment,
        block: client.sessionRoot.toolBlocklist[mcpToolRefKey("github", "merge_pull_request")],
      };
    },
    expected: { calls: [], draft: "", humanApprove: false, comment: "no", block: undefined },
  },
  {
    name: "superKey cmd remember uses meta, not ctrl",
    play: () => {
      const client = localClient();
      const calls: Array<{ method: string; params: unknown }> = [];
      client.request = async (method, params) => {
        answerLikeDaemon(client, method, params);
        if (method !== "ask/answer") calls.push({ method, params });
        return { ok: true };
      };
      client.kernelRoot.superKey = "cmd";
      const looked = mcpAsk("get_issue");
      client.sessionRoot.head = looked.turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true });
      const ctrl = {
        humanApprove: looked.leaf.humanApprove,
        grants: client.sessionRoot.grantsJson,
        calls: [...calls],
      };
      press(tea, "Enter", { meta: true });
      return {
        ctrl,
        meta: {
          humanApprove: looked.leaf.humanApprove,
          grants: parseGrantRows(client.sessionRoot.grantsJson).map((row) => row.scope),
          calls,
        },
      };
    },
    expected: {
      ctrl: { humanApprove: null, grants: "", calls: [] },
      meta: { humanApprove: true, grants: ["session"], calls: [] },
    },
  },
  {
    name: "extra-root read Ctrl+Enter says yes to treating the suggested folder as part of the session",
    play: () => {
      const client = localClient();
      const spec = extraRead("/tmp/other/spec.md", "r1");
      const readme = extraRead("/tmp/other/readme.md", "r2");
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`read them`,
        doneWork: [spec, readme],
        queue: [],
      });
      turn.pushChild(spec);
      turn.pushChild(readme);
      client.sessionRoot.head = turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true });
      return {
        calls: [],
        draft: tea.draft.draft,
        humanApprove: spec.humanApprove,
        parent: client.sessionRoot.readRoots["/tmp/other"],
        file: client.sessionRoot.readRoots["/tmp/other/spec.md"],
      };
    },
    expected: {
      calls: [],
      draft: "",
      humanApprove: true,
      parent: "session",
      file: undefined,
    },
  },
  {
    name: "extra-root once does not widen",
    play: () => {
      const client = localClient();
      const lone = extraRead("/tmp/other/spec.md", "r3");
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`read one`,
        doneWork: [lone],
        queue: [],
      });
      turn.pushChild(lone);
      client.sessionRoot.head = turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter", { ctrl: true });
      return {
        calls: [],
        draft: tea.draft.draft,
        humanApprove: lone.humanApprove,
        parent: client.sessionRoot.readRoots["/tmp/other"],
      };
    },
    expected: { calls: [], draft: "", humanApprove: null, parent: undefined },
  },
  {
    name: "a folder already treated as part of the session is not suggested again",
    play: () => {
      const client = localClient();
      client.sessionRoot.addReadRoot("/tmp/other");
      const next = extraRead("/tmp/other/readme.md", "r4");
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`read next`,
        doneWork: [next],
        queue: [],
      });
      turn.pushChild(next);
      client.sessionRoot.head = turn;
      using tea = new Tea(client, () => undefined);
      press(tea, "Enter");
      return {
        calls: [],
        draft: tea.draft.draft,
        humanApprove: next.humanApprove,
        roots: Object.keys(client.sessionRoot.readRoots),
      };
    },
    expected: { calls: [], draft: "", humanApprove: true, roots: ["/tmp/other"] },
  },
  {
    name: "extra-root comment does not widen",
    play: () => {
      const client = localClient();
      const a = extraRead("/tmp/other/spec.md", "r5");
      const b = extraRead("/tmp/other/readme.md", "r6");
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`read them`,
        doneWork: [a, b],
        queue: [],
      });
      turn.pushChild(a);
      turn.pushChild(b);
      client.sessionRoot.head = turn;
      using tea = new Tea(client, () => undefined);
      typeText(tea, "ok folder");
      press(tea, "Enter", { ctrl: true });
      return {
        calls: [],
        draft: tea.draft.draft,
        humanApprove: a.humanApprove,
        comment: a.approvalComment,
        parent: client.sessionRoot.readRoots["/tmp/other"],
      };
    },
    expected: { calls: [], draft: "", humanApprove: true, comment: "ok folder", parent: undefined },
  },
])("persist $name", ({ play, expected }) => {
  expect(play()).toEqual(expected);
});

test("throttled ask over a slash draft keeps Enter inert and the catalog prefix", () => {
  let now = 1_000;
  const client = localClient();
  client.kernelRoot.approvalAskThrottleMs = 2_000;
  const asked = askTurn();
  using tea = new Tea(client, () => undefined, { now: () => now });
  typeText(tea, "/c");
  client.sessionRoot.head = asked.turn;
  press(tea, "Enter");
  const inert = { approved: asked.leaf.humanApprove, draft: tea.draft.draft };
  now = 3_000;
  tea.handle({ kind: "input_events", events: [] });
  press(tea, "Enter");
  expect({
    inert,
    after: { approved: asked.leaf.humanApprove, draft: tea.draft.draft },
  }).toEqual({
    inert: { approved: null, draft: "/c" },
    after: { approved: true, draft: "/c" },
  });
});

test("isolated cover Tab does not rewrite a slash draft", () => {
  const client = localClient();
  const asked = askTurn();
  using tea = new Tea(client, () => undefined);
  typeText(tea, "/c");
  client.sessionRoot.head = asked.turn;
  press(tea, "Tab");
  const tab = { approved: asked.leaf.humanApprove, draft: tea.draft.draft };
  press(tea, "Enter");
  expect({
    tab,
    enter: { approved: asked.leaf.humanApprove, draft: tea.draft.draft },
  }).toEqual({
    tab: { approved: null, draft: "/c" },
    enter: { approved: true, draft: "/c" },
  });
});

function escalateAsk(opts: {
  readonly scope?: AgentNature;
  readonly oneShot?: boolean;
  readonly roster?: "session" | "project" | "global";
  readonly workerId?: string;
  readonly hostAsk?: boolean;
}): {
  readonly client: Client;
  readonly worker: ReturnType<typeof SessionPlexus.create>;
  readonly workerLeaf: SystemToolJob;
  readonly hostLeaf: SystemToolJob | null;
} {
  const workerId = opts.workerId ?? "w-explore";
  const client = localClient();
  const callProps = {
    toolCallId: "call-explore",
    argsJson: JSON.stringify({ spec: "explore", message: "map" }),
    workerSessionId: workerId,
  };
  const call =
    opts.oneShot === false
      ? new BotCallJob({ ...callProps, name: "bot__send" })
      : new AgentCallJob({ ...callProps, name: "agent__ask" });
  const hostAsked = opts.hostAsk === true ? askTurn("host-ask") : null;
  const doneWork = hostAsked == null ? [call] : [call, hostAsked.leaf];
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`go`,
    doneWork,
    queue: [],
  });
  if (hostAsked != null) turn.pushChild(hostAsked.leaf);
  client.sessionRoot.head = turn;
  if (opts.roster === "session") client.sessionRoot.botsRoster.explore = workerId;
  if (opts.roster === "project") client.projectRoot.botsRoster.explore = workerId;
  if (opts.roster === "global") client.kernelRoot.botsRoster.explore = workerId;
  client.kernelRoot.sessions[workerId] = new SessionOverview({
    specName: "explore",
    recipeScope: opts.scope ?? "",
    oneShot: opts.oneShot ?? true,
    keepAlive: opts.roster === "session",
    asking: true,
    unfinished: "ask",
  });
  const worker = SessionPlexus.create(workerId, "/tmp/p");
  if (opts.oneShot !== false) worker.root.agent.spec = new AskAgentSpec({ name: "explore" });
  else if (opts.scope === "session" || opts.scope === "project" || opts.scope === "global") {
    worker.root.agent.spec.recipeScope = opts.scope;
    worker.root.agent.spec.name = "explore";
  }
  worker.root.ensureAgentCallback(call.uuid, client.sessionId);
  const asked = askTurn("worker-ask");
  worker.root.head = asked.turn;
  client.adoptAsk(worker);
  return { client, worker, workerLeaf: asked.leaf, hostLeaf: hostAsked?.leaf ?? null };
}

test.each([
  {
    name: "one-shot worker ask writes the worker leaf from the host cover",
    play: () => {
      const bag = escalateAsk({});
      using tea = new Tea(bag.client, () => undefined);
      press(tea, "Enter");
      return { approved: bag.workerLeaf.humanApprove };
    },
    expected: { approved: true },
  },
  {
    name: "session-nature worker ask writes the worker leaf from the host cover",
    play: () => {
      const bag = escalateAsk({ oneShot: false, scope: "session", roster: "session" });
      using tea = new Tea(bag.client, () => undefined);
      press(tea, "Enter");
      return { approved: bag.workerLeaf.humanApprove };
    },
    expected: { approved: true },
  },
  {
    name: "host ask wins over a sitting one-shot ask",
    play: () => {
      const bag = escalateAsk({ hostAsk: true });
      using tea = new Tea(bag.client, () => undefined);
      press(tea, "Enter");
      return { host: bag.hostLeaf?.humanApprove, worker: bag.workerLeaf.humanApprove };
    },
    expected: { host: true, worker: null },
  },
  {
    name: "project-nature worker ask does not raise the host cover",
    play: () => {
      const bag = escalateAsk({ oneShot: false, scope: "project", roster: "project" });
      using tea = new Tea(bag.client, () => undefined);
      press(tea, "Enter");
      return { approved: bag.workerLeaf.humanApprove, draft: tea.draft.draft };
    },
    expected: { approved: null, draft: "" },
  },
  {
    name: "global-nature worker ask does not raise the host cover",
    play: () => {
      const bag = escalateAsk({ oneShot: false, scope: "global", roster: "global" });
      using tea = new Tea(bag.client, () => undefined);
      press(tea, "Enter");
      return { approved: bag.workerLeaf.humanApprove };
    },
    expected: { approved: null },
  },
  {
    name: "remember on an escalated ask stores on the host desk; the worker follows",
    play: () => {
      const bag = escalateAsk({});
      bag.workerLeaf.stampPolicy("ask", null, null, {
        classesJson: JSON.stringify(["workspace-write"]),
        votesJson: JSON.stringify([
          { disposition: "ask", class: "workspace-write", ruleId: "w", path: { cluster: "write", path: "src/a.ts" } },
        ]),
      });
      const calls: Array<{ method: string; params: unknown }> = [];
      bag.client.request = async (method, params) => {
        answerLikeDaemon(bag.client, method, params);
        calls.push({ method, params });
        return { ok: true };
      };
      using tea = new Tea(bag.client, () => undefined);
      press(tea, "Enter", { ctrl: true });
      return {
        calls,
        humanApprove: bag.workerLeaf.humanApprove,
        host: parseGrantRows(bag.client.sessionRoot.grantsJson).map((row) => row.scope),
      };
    },
    expected: {
      calls: [
        {
          method: "ask/answer",
          params: {
            sessionId: "w-explore",
            jobId: expect.any(String),
            allow: true,
            store: { scope: "session", subject: { kind: "path", cluster: "write", path: "src/a.ts", depth: "exact" } },
          },
        },
      ],
      humanApprove: true,
      host: ["session"],
    },
  },
])("escalate $name", ({ play, expected }) => {
  expect(play()).toEqual(expected);
});

test("an answer is an ask/answer RPC; the TUI writes nothing on its replica", async () => {
  const client = localClient();
  const calls: Array<{ method: string; params: unknown }> = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  const asked = askTurn();
  client.sessionRoot.head = asked.turn;
  using tea = new Tea(client, () => undefined);
  typeText(tea, "use b.ts");
  press(tea, "Escape", { ctrl: true });
  expect({ calls, approve: asked.call.humanApprove, comment: asked.call.approvalComment }).toEqual({
    calls: [
      {
        method: "ask/answer",
        params: { sessionId: "s", jobId: asked.call.uuid, allow: false, comment: "use b.ts" },
      },
    ],
    approve: null,
    comment: null,
  });
});

test("shift-tab to yolo drops an escalated cover without writing approved", () => {
  const bag = escalateAsk({});
  bag.client.request = async (method, params) => {
    answerLikeDaemon(bag.client, method, params);
    // Stand in for the daemon: policy/set is the only writer of the mode.
    if (method === "policy/set") bag.client.sessionRoot.permissionMode = (params as { policy: "yolo" }).policy;
    return { ok: true };
  };
  using tea = new Tea(bag.client, () => undefined);
  const before = bag.workerLeaf.needsHuman;
  press(tea, "Tab", { shift: true });
  press(tea, "Tab", { shift: true });
  expect({
    before,
    policy: { host: bag.client.sessionRoot.permissionMode, worker: bag.worker.root.permissionMode },
    cover: bag.workerLeaf.needsHuman,
    humanApprove: bag.workerLeaf.humanApprove,
  }).toEqual({
    before: true,
    policy: { host: "yolo", worker: "yolo" },
    cover: false,
    humanApprove: null,
  });
});

test("cover contour is yellow on floor deny, furniture on ask", () => {
  function contourOf(leaf: SystemToolJob): string {
    const client = localClient();
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`do it`,
      doneWork: [leaf],
      queue: [],
    });
    turn.pushChild(leaf);
    client.sessionRoot.head = turn;
    using tea = new Tea(client, () => undefined);
    tea.flushPaint();
    const composer = tea.paintRoot.children.find((child) => child.kind === "composer");
    return composer !== undefined && "contourRole" in composer ? composer.contourRole : "";
  }
  expect({
    editAsk: contourOf(
      new SystemToolJob({
        toolCallId: "e",
        name: "edit_file",
        argsJson: '{"path":"a.ts"}',
        policyResult: "ask",
      }),
    ),
    shellDeny: contourOf(
      new SystemToolJob({
        toolCallId: "d",
        name: "shell",
        argsJson: '{"command":"rm file"}',
        policyResult: "deny",
      }),
    ),
  }).toEqual({
    editAsk: "",
    shellDeny: "emphasis",
  });
});

test("escalated cover rim names the agent before the tool", () => {
  const bag = escalateAsk({});
  const shell = new SystemToolJob({
    toolCallId: "worker-shell",
    name: "shell",
    argsJson: '{"command":"rg -n skill"}',
    policyResult: "ask",
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`map`,
    doneWork: [shell],
    queue: [],
  });
  turn.pushChild(shell);
  bag.worker.root.head = turn;
  using tea = new Tea(bag.client, () => undefined);
  tea.flushPaint();
  const composer = tea.paintRoot.children.find((child) => child.kind === "composer");
  expect(composer !== undefined && "annotation" in composer ? composer.annotation : "").toBe(
    "Ask · **Explore agent** · run command",
  );
});

test("the prompt names the tier, why the floor asked, the judge's reason and the folder question", () => {
  const soft = rememberAsk("ann", "deny").call;
  soft.stampPolicy("deny", null, null, {
    classesJson: JSON.stringify(["publish", "remote-write"]),
    votesJson: "[]",
  });
  expect(askAnnotation(soft, undefined, undefined)).toBe(
    "Soft-deny · Publishes, Changes remote state · licensed every time, nothing is remembered",
  );
  soft.classifierResult = "deny";
  soft.judgeReason = "the user asked to cut a release, not to publish";
  expect(askAnnotation(soft, "ran by agent", { label: "../docs" })).toBe(
    "Soft-deny · Publishes, Changes remote state · licensed every time, nothing is remembered · Judge: the user asked to cut a release, not to publish · ran by agent · Treat ../docs as part of this session?",
  );
  const ask = rememberAsk("ann2").call;
  expect(askAnnotation(ask, undefined, undefined)).toBe("Ask · Writes in the workspace");
});
