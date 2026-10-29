import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  AgentCallNotification,
  type BlobPeek,
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  FileMutateToolJob,
  KernelRoot,
  ProgrammaticJob,
  ReACTChunk,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  storedBlobJson,
  SystemToolJob,
  TurnNotificationChunk,
  TurnPromptChunk,
  TurnSteerChunk,
  admitQueue,
  admitSteer,
} from "@inhuman.tools/harness-model";
import { observable, runInAction } from "mobx";
import { expect, test } from "vitest";

import { completionPaintFields, createPaintController, paintComposerFace } from "../paint-controller.js";
import { paintChildrenOf, speechOf, thinkingOf } from "../paint-dom.js";
import { createPaintReader, type PaintDownMessage } from "../paint-transport.js";
import type { WorkCellFace } from "../work-cells.js";

function flush(): Promise<void> {
  return Promise.resolve();
}

function turnChildren(paint: ReturnType<typeof createPaintController>) {
  const tape = paintChildrenOf(paint.root).at(0);
  if (tape === undefined || tape.kind !== "stack") return [];
  const painted = paintChildrenOf(tape).at(0);
  return painted === undefined ? [] : paintChildrenOf(painted);
}

test("composer face table: oauth, waiting, secret, isolated, normal", () => {
  const draft = { draft: "raw-secret", cursor: 3, mark: null };
  const cover = { draft: "allow?", cursor: 2, mark: 0 };
  const choices = [{ key: "c1", name: "/connect", actions: [] }];
  const isolated = paintComposerFace({
    oauthWaiting: false,
    busy: false,
    inputting: false,
    processing: false,
    secret: false,
    isolated: true,
    coverDraft: { draft: "why", cursor: 3, mark: null },
    draft: { draft: "keep", cursor: 4, mark: null },
    commandChoices: choices,
    selectedCommandKey: "c1",
    placeholder: "Allow this tool?",
    hotkeys: [
      { key: "Enter", action: "Allow" },
      { key: "Esc", action: "Deny" },
    ],
    statusItems: ["gpt-4"],
    quotaWindows: [{ remainingPercent: 67, resetAt: 7200 }],
  });
  expect({
    oauth: paintComposerFace({
      oauthWaiting: true,
      busy: false,
      inputting: false,
      processing: false,
      secret: true,
      isolated: false,
      coverDraft: cover,
      draft,
    }),
    busy: paintComposerFace({
      oauthWaiting: false,
      busy: true,
      inputting: false,
      processing: false,
      secret: false,
      isolated: false,
      coverDraft: cover,
      draft,
    }).mode,
    secret: paintComposerFace({
      oauthWaiting: false,
      busy: false,
      inputting: false,
      processing: false,
      secret: true,
      isolated: false,
      coverDraft: cover,
      draft,
    }),
    isolatedMode: paintComposerFace({
      oauthWaiting: false,
      busy: false,
      inputting: false,
      processing: false,
      secret: false,
      isolated: true,
      coverDraft: cover,
      draft,
    }),
    normal: paintComposerFace({
      oauthWaiting: false,
      busy: false,
      inputting: false,
      processing: false,
      secret: false,
      isolated: false,
      coverDraft: cover,
      draft,
    }),
    isolatedChrome: isolated,
  }).toMatchObject({
    oauth: {
      mode: "waiting",
      interactive: false,
      draft: "Waiting for the browser…",
      cursor: 0,
      mark: null,
    },
    busy: "waiting",
    secret: {
      mode: "secret",
      interactive: true,
      draft: "••••••••••",
      cursor: 3,
      mark: null,
    },
    isolatedMode: { mode: "isolated", interactive: true, draft: "allow?" },
    normal: { mode: "normal", interactive: true, draft: "raw-secret" },
    isolatedChrome: {
      mode: "isolated",
      interactive: true,
      draft: "why",
      commandChoices: undefined,
      selectedCommandKey: null,
      stackedBody: undefined,
      placeholder: "Allow this tool?",
      hotkeys: [
        { key: "Enter", action: "Allow" },
        { key: "Esc", action: "Deny" },
      ],
      statusItems: ["gpt-4"],
      quotaWindows: [{ remainingPercent: 67, resetAt: 7200 }],
    },
  });

  const paint = createPaintController(() => undefined);
  paint.projectComposer(
    paintComposerFace({
      oauthWaiting: false,
      busy: false,
      inputting: false,
      processing: false,
      secret: false,
      isolated: false,
      coverDraft: { draft: "", cursor: 0, mark: null },
      draft: { draft: "", cursor: 0, mark: null },
      placeholder: "Ask",
      statusItems: ["opus"],
      quotaWindows: [{ remainingPercent: 50, resetAt: 3600 }],
      contextUsed: 10_000,
      contextLimit: 500_000,
      commandChoices: choices,
      selectedCommandKey: "c1",
    }),
  );
  expect({
    placeholder: paint.composer.placeholder,
    statusItems: paint.composer.statusItems,
    quotaWindows: paint.composer.quotaWindows,
    contextUsed: paint.composer.contextUsed,
    contextLimit: paint.composer.contextLimit,
    commandChoices: paint.composer.commandChoices,
    selectedCommandKey: paint.composer.selectedCommandKey,
  }).toEqual({
    placeholder: "Ask",
    statusItems: ["opus"],
    quotaWindows: [{ remainingPercent: 50, resetAt: 3600 }],
    contextUsed: 10_000,
    contextLimit: 500_000,
    commandChoices: choices,
    selectedCommandKey: "c1",
  });
  paint[Symbol.dispose]();
});

test("completion fields: unhomed live uses responseText, failed uses responseText", () => {
  const live = new CompletionExpectation({ connectionId: "c", model: "m" });
  live.responseText = "hello";
  live.responseThought = "hmm";
  live.responseThoughtKind = "summary";
  const unhomed = completionPaintFields(live);
  live.markStarted(1_000);
  live.markThoughtEnded(1_250);
  const thoughtEnded = completionPaintFields(live);
  live.markEnded(1_400);
  live.outcome = "successful";
  const successful = completionPaintFields(live);

  const failed = new CompletionExpectation({ connectionId: "c" });
  failed.responseText = "partial";
  failed.outcome = "failed";
  failed.endDetail = "boom";
  failed.failReason = "x";

  const cutoff = new CompletionExpectation({ connectionId: "c" });
  cutoff.outcome = "failed";
  cutoff.endCause = "cancel";
  cutoff.endDetail = "terminate";

  const hanging = new CompletionExpectation({ connectionId: "c", model: "m" });
  hanging.markStarted(1_000);

  expect({
    unhomed,
    thoughtEnded,
    successful,
    failed: completionPaintFields(failed),
    cutoff: completionPaintFields(cutoff),
    hanging: completionPaintFields(hanging),
    hangingCutoff: completionPaintFields(hanging, true),
  }).toMatchObject({
    unhomed: {
      state: "live",
      text: "hello",
      thought: "hmm",
      thoughtKind: "summary",
      workerPresent: false,
      model: "m",
      startedAt: null,
      durationMs: null,
      thoughtLive: false,
    },
    thoughtEnded: {
      state: "live",
      thoughtLive: false,
      startedAt: 1_000,
      durationMs: 250,
      atMs: 1_250,
    },
    successful: {
      state: "successful",
      thoughtLive: false,
      startedAt: 1_000,
      durationMs: 250,
    },
    failed: {
      state: "failed",
      text: "partial",
      endDetail: "boom",
      failReason: "x",
      debugNote: "",
    },
    cutoff: {
      state: "successful",
      endDetail: "",
      failReason: "",
    },
    hanging: {
      state: "live",
      thoughtLive: true,
      durationMs: null,
    },
    hangingCutoff: {
      state: "successful",
      thoughtLive: false,
      workerPresent: false,
      endDetail: "",
      failReason: "",
    },
  });
});

test("completion debugNote is per-round cache status only under DEBUG", () => {
  const chunk = new CompletionExpectation({ connectionId: "c" });
  chunk.outcome = "successful";
  chunk.expectedCacheHit = true;
  chunk.cacheHit = false;
  chunk.cachedTokens = 0;
  const previous = process.env.DEBUG;
  try {
    delete process.env.DEBUG;
    const off = completionPaintFields(chunk).debugNote;
    process.env.DEBUG = "*";
    const miss = completionPaintFields(chunk).debugNote;
    chunk.cacheHit = true;
    chunk.cachedTokens = 128;
    const missCount = completionPaintFields(chunk).debugNote;
    chunk.cachedTokens = 256;
    const aligned = completionPaintFields(chunk).debugNote;
    chunk.expectedCacheHit = false;
    const unexpected = completionPaintFields(chunk).debugNote;
    chunk.cachedTokens = 128;
    const unexpectedAligned = completionPaintFields(chunk).debugNote;
    chunk.cacheHit = false;
    chunk.cachedTokens = 0;
    const empty = completionPaintFields(chunk).debugNote;
    expect({
      off,
      miss,
      missCount,
      aligned,
      unexpected,
      unexpectedAligned,
      empty,
    }).toEqual({
      off: "",
      miss: "cache miss · expected hit · 0 cached",
      missCount: "cache miss · expected hit · 128 cached",
      aligned: "",
      unexpected: "cache hit · unexpected · 256 cached",
      unexpectedAligned: "",
      empty: "",
    });
  } finally {
    if (previous === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previous;
  }
});

test("controller projects spine and secret mask; attach posts paint_init", async () => {
  const posted: PaintDownMessage[] = [];
  const paint = createPaintController((message) => posted.push(message));
  const chunk = new CompletionExpectation({ connectionId: "c", model: "m" });
  chunk.responseText = "hi";
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [new CompletionJob({ expectation: chunk })],
    queue: [],
  });
  paint.syncSpine([turn]);
  paint.projectComposer(
    paintComposerFace({
      oauthWaiting: false,
      busy: false,
      inputting: false,
      processing: false,
      secret: true,
      isolated: false,
      coverDraft: { draft: "", cursor: 0, mark: null },
      draft: { draft: "ab", cursor: 2, mark: null },
    }),
  );
  paint.attach();
  const reader = createPaintReader();
  reader.apply(posted[0]!);
  const [tape, composer] = paintChildrenOf(reader.root!);
  if (composer?.kind !== "composer") throw new Error("composer");
  const turnNode = tape?.kind === "stack" ? paintChildrenOf(tape).at(0) : undefined;
  const promptNode = turnNode === undefined ? undefined : paintChildrenOf(turnNode).at(0);
  const completion = turnNode === undefined ? undefined : paintChildrenOf(turnNode).at(1);
  if (completion?.kind !== "completion") throw new Error("completion");
  expect({
    init: posted[0]?.kind,
    tape: tape?.kind,
    composer: { kind: composer.kind, draft: composer.draft, mode: composer.mode },
    prompt: promptNode?.kind === "speech" ? { voice: promptNode.voice, text: promptNode.text } : promptNode?.kind,
    speech: speechOf(completion).text,
    thought: thinkingOf(completion).text,
  }).toEqual({
    init: "paint_init",
    tape: "stack",
    composer: { kind: "composer", draft: "••", mode: "secret" },
    prompt: { voice: "user", text: "p" },
    speech: "hi",
    thought: "",
  });

  chunk.responseText = "hi!";
  paint.syncSpine([turn]);
  await flush();
  expect(posted.some((item) => item.kind === "paint_patch")).toBe(true);
  reader.dispose();
  paint[Symbol.dispose]();
});

test("controller projects a preview spine and retracts it", () => {
  const paint = createPaintController(() => undefined);
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`peek`,
    doneWork: [],
    queue: [],
  });
  paint.syncPreviewSpine([]);
  const empty = paintChildrenOf(paint.root).some((child) => child.kind === "preview");
  paint.syncPreviewSpine([turn]);
  const preview = paintChildrenOf(paint.root).find((child) => child.kind === "preview");
  const turnNode = preview?.kind === "preview" ? paintChildrenOf(preview).at(0) : undefined;
  const promptNode = turnNode === undefined ? undefined : paintChildrenOf(turnNode).at(0);
  const promptFace =
    promptNode?.kind === "speech" ? { voice: promptNode.voice, text: promptNode.text } : promptNode?.kind;
  const open = preview?.kind;
  paint.syncPreviewSpine(null);
  expect({
    empty,
    open,
    prompt: promptFace,
    reducerExited: paintChildrenOf(paint.root).some((child) => child.kind === "preview"),
  }).toEqual({
    empty: true,
    open: "preview",
    prompt: { voice: "user", text: "peek" },
    reducerExited: false,
  });
  paint[Symbol.dispose]();
});

test("cancelRequested seals a live empty thought on the spine", () => {
  const chunk = new CompletionExpectation({ connectionId: "c", model: "m" });
  chunk.markStarted(1_000);
  const paint = createPaintController(() => undefined);
  paint.syncSpine([
    new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      cancelRequested: true,
      doneWork: [new CompletionJob({ expectation: chunk })],
      queue: [new ReACTChunk()],
    }),
  ]);
  const children = turnChildren(paint);
  const completion = children.find((child) => child.kind === "completion");
  expect({
    completion,
    loop: children.some((child) => child.kind === "loop"),
  }).toEqual({
    completion: expect.objectContaining({
      kind: "completion",
      state: "successful",
      thoughtLive: false,
      workerPresent: false,
    }),
    loop: false,
  });
  paint[Symbol.dispose]();
});

test("spine is prompt + tools and schemes; loop tokens stay off", () => {
  const tool = new SystemToolJob({
    toolCallId: "call_1",
    name: "read_file",
    argsJson: '{"path":"a.ts"}',
  });
  const scheme = new ProgrammaticJob({
    toolCallId: "call_repl",
    argsJson: '{"expr":"(read_file :path \\"a.ts\\")"}',
  });
  const inner = new SystemToolJob({
    toolCallId: "call_inner",
    name: "read_file",
    argsJson: '{"path":"a.ts"}',
  });
  scheme.pushInvocation(inner);
  const paint = createPaintController(() => undefined);
  paint.syncSpine([
    new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [tool, scheme],
      queue: [new ReACTChunk(), new TurnPromptChunk(), new CompactJob()],
    }),
  ]);
  expect(turnChildren(paint).map((child) => child.kind)).toEqual(["speech", "tool", "scheme", "tool"]);
  paint[Symbol.dispose]();
});

test("CompactJob cutoff and failure are tape notices; a pending job stays off", () => {
  const overflow = new CompactJob({ reason: "overflow", standIn: "card", completed: true, keepTurns: 1 });
  const focused = new CompactJob({ reason: "user", standIn: "card", completed: true, keepTurns: 1 });
  const failed = new CompactJob({
    reason: "overflow",
    failed: true,
    completed: true,
    notice: "couldn't compact — try again later",
  });
  const pending = new CompactJob({ reason: "user" });
  const paint = createPaintController(() => undefined);
  paint.syncSpine([
    new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`keep the plan`,
      doneWork: [overflow, focused, failed],
      queue: [pending],
    }),
  ]);
  const children = turnChildren(paint);
  expect({
    kinds: children.map((child) => child.kind),
    overflow: children[1]?.kind === "compact" ? children[1].text : children[1]?.kind,
    focused: children[2]?.kind === "compact" ? children[2].text : children[2]?.kind,
    failed: children[3]?.kind === "compact" ? children[3].text : children[3]?.kind,
  }).toEqual({
    kinds: ["speech", "compact", "compact", "compact"],
    overflow: "compacted",
    focused: "compacted · keep the plan",
    failed: "couldn't compact — try again later",
  });
  paint[Symbol.dispose]();
});

test("unconsumed agent notify is a tape recall, not spawn body", () => {
  const call = new AgentCallJob({
    toolCallId: "a",
    name: "agent__ask",
    argsJson: '{"spec":"reviewer","message":"check the diff"}',
  });
  call.notifications.push(new AgentCallNotification({ message: "found 3 issues" }));
  const paint = createPaintController(() => undefined);
  paint.syncSpine([
    new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      doneWork: [call],
      queue: [],
    }),
  ]);
  const children = turnChildren(paint);
  const spawn = children[1];
  const recall = children[2];
  expect({
    kinds: children.map((child) => child.kind),
    spawn: spawn?.kind === "tool" ? { prettyBlock: spawn.prettyBlock, name: spawn.name } : spawn?.kind,
    recall: recall?.kind === "recall" ? recall.text : recall?.kind,
  }).toEqual({
    kinds: ["speech", "tool", "recall"],
    spawn: { prettyBlock: "check the diff", name: "reviewer" },
    recall: "from reviewer: found 3 issues",
  });
  call.notifications[0]!.message = "found 4 issues";
  expect(recall?.kind === "recall" ? recall.text : recall?.kind).toBe("from reviewer: found 4 issues");
  paint[Symbol.dispose]();
});

test("a notify rewound past its claim cell paints again", () => {
  const plexus = SessionPlexus.create("s-notify-rewind", "/tmp/notify-rewind");
  const call = new AgentCallJob({
    toolCallId: "a",
    name: "agent__ask",
    argsJson: '{"spec":"reviewer","message":"check the diff"}',
  });
  const note = new AgentCallNotification({ message: "found 3 issues" });
  call.notifications.push(note);
  const producer = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [call],
    queue: [],
    reducerExited: true,
  });
  producer.pushChild(call);
  plexus.root.head = producer;
  plexus.root.head = new SessionTurn({
    turnTail: producer,
    doneWork: [new TurnNotificationChunk({ notifications: [note] })],
    queue: [],
  });
  const paint = createPaintController(() => undefined);
  const kinds = (): string[] => {
    paint.syncSpine([producer]);
    return turnChildren(paint).map((child) => child.kind);
  };
  const claimed = kinds();
  plexus.root.head = producer;
  expect({ claimed, rewound: kinds() }).toEqual({
    claimed: ["speech", "tool"],
    rewound: ["speech", "tool", "recall"],
  });
  paint[Symbol.dispose]();
  plexus.destroy();
});

test("update_metadata stays off the tape", () => {
  const meta = new SystemToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    toolCallId: "m",
    name: "update_metadata",
    argsJson: '{"title":"Fix auth"}',
  });
  const paint = createPaintController(() => undefined, "paint");
  paint.syncSpine([
    new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [meta],
      queue: [],
    }),
  ]);
  expect(turnChildren(paint).map((child) => child.kind)).toEqual(["speech"]);
  paint[Symbol.dispose]();
});

test("live floor call stays on the tape before it seals", () => {
  const read = new SystemToolJob({
    toolCallId: "r",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
    policyResult: "policyApprove",
  });
  const paint = createPaintController(() => undefined);
  paint.syncSpine([
    new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [read],
      queue: [],
    }),
  ]);
  const tool = turnChildren(paint).find((child) => child.kind === "tool");
  expect(
    tool?.kind === "tool" ? { fuse: tool.fuse, state: tool.state, object: tool.object, name: tool.name } : tool?.kind,
  ).toEqual({
    fuse: false,
    state: "live",
    object: "Read **src/tea.ts**",
    name: "read_file",
  });
  paint[Symbol.dispose]();
});

test("fuse stamp stays off unless hideFloorTools", () => {
  const glob = new SystemToolJob({
    toolCallId: "g",
    name: "glob",
    argsJson: '{"pattern":"**/*.ts"}',
    policyResult: "policyApprove",
    completed: true,
    outcomeJson: '{"ok":true,"text":"a.ts"}',
  });
  const paint = createPaintController(() => undefined);
  paint.syncSpine([
    new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [glob],
      queue: [],
    }),
  ]);
  const tools = turnChildren(paint).flatMap((child) => (child.kind === "tool" ? [child] : []));
  expect(tools.map((tool) => [tool.toolCallId, tool.fuse])).toEqual([["g", false]]);
  paint[Symbol.dispose]();
});

test("fuse stamp is floor-allow only when hideFloorTools", () => {
  const glob = new SystemToolJob({
    toolCallId: "g",
    name: "glob",
    argsJson: '{"pattern":"**/*.ts"}',
    policyResult: "policyApprove",
    completed: true,
    outcomeJson: '{"ok":true,"text":"a.ts"}',
  });
  const write = new SystemToolJob({
    toolCallId: "w",
    name: "write_file",
    argsJson: '{"path":"a.ts","content":"hi"}',
    policyResult: "ask",
    classifierResult: "allow",
    completed: true,
    outcomeJson: '{"ok":true,"text":"wrote"}',
  });
  const edit = new SystemToolJob({
    toolCallId: "e",
    name: "edit_file",
    argsJson: '{"path":"b.ts","old_string":"a","new_string":"b"}',
    policyResult: "ask",
    humanApprove: true,
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const kernel = new KernelRoot();
  kernel.hideFloorTools = true;
  const paint = createPaintController(() => undefined, "paint", { kernel });
  paint.syncSpine([
    new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [glob, write, edit],
      queue: [],
    }),
  ]);
  const tools = turnChildren(paint).flatMap((child) => (child.kind === "tool" ? [child] : []));
  expect(tools.map((tool) => [tool.toolCallId, tool.fuse])).toEqual([
    ["g", true],
    ["w", false],
    ["e", false],
  ]);
  paint[Symbol.dispose]();
});

test("ask-lifecycle spine: cut, applying, uncut", () => {
  const prior = new SystemToolJob({
    toolCallId: "e1",
    name: "read_file",
    argsJson: '{"path":"a.ts"}',
    humanApprove: true,
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const head = new SystemToolJob({
    toolCallId: "e2",
    name: "edit_file",
    argsJson: '{"path":"b.ts","old_string":"a","new_string":"b"}',
  });
  const speech = new CompletionExpectation({ connectionId: "c" });
  speech.succeed("settled", "", JSON.stringify({ text: "next" }), { result: { text: "next" } });
  const later = new SystemToolJob({
    toolCallId: "e3",
    name: "read_file",
    argsJson: '{"path":"c.ts"}',
    humanApprove: true,
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [prior, head, new CompletionJob({ expectation: speech }), later],
    queue: [],
  });
  const paint = createPaintController(() => undefined);
  paint.syncSpine([turn]);

  head.policyResult = "ask";
  paint.syncSpine([turn]);
  const toolsOf = () => turnChildren(paint).flatMap((child) => (child.kind === "tool" ? [child.object] : []));
  const cut = { kinds: turnChildren(paint).map((child) => child.kind), tools: toolsOf() };

  head.humanApprove = true;
  paint.syncSpine([turn]);
  const applying = { kinds: turnChildren(paint).map((child) => child.kind), tools: toolsOf() };

  head.receiptJson = '{"ok":true}';
  head.completed = true;
  expect(() => {
    paint.syncSpine([turn]);
  }).not.toThrow();
  const uncut = { kinds: turnChildren(paint).map((child) => child.kind), tools: toolsOf() };

  expect({
    cut,
    applying,
    uncut,
  }).toEqual({
    cut: { kinds: ["speech", "tool", "completion"], tools: ["Read **a.ts**"] },
    applying: { kinds: ["speech", "tool", "completion"], tools: ["Read **a.ts**"] },
    uncut: {
      kinds: ["speech", "tool", "tool", "completion", "tool"],
      tools: ["Read **a.ts**", "b.ts", "Read **c.ts**"],
    },
  });
  paint[Symbol.dispose]();
});

test("pin arbitration: wait and ask seat before the composer and clear", () => {
  const paint = createPaintController(() => undefined);
  paint.projectWait({
    occupancy: {
      kind: "waiting",
      label: "waiting for response...",
      elapsed: true,
      startedAt: 1_000,
      retryUntilMs: null,
    },
    error: "",
  });
  const wait = paintChildrenOf(paint.root).find((child) => child.kind === "wait");
  const waitFace = wait?.kind === "wait" ? { kind: wait.kind, name: wait.name, startedAt: wait.startedAt } : wait;
  const waitKinds = paintChildrenOf(paint.root).map((child) => child.kind);

  const face: WorkCellFace = {
    key: "ask:e",
    state: "ask",
    name: "edit_file",
    object: "a.ts",
    status: "ask",
    caption: "",
    pathShaped: true,
    split: false,
    agent: false,
    pretty: false,
    prettyBlock: "",
    response: "",
    indent: false,
    collapsed: false,
    receipt: { kind: "diff", old: "a", new: "b", path: "a.ts" },
    rimNamed: true,
  };
  paint.projectAsk(face);
  const both = paintChildrenOf(paint.root).map((child) => child.kind);
  paint.projectWait(null);
  const askOnly = paintChildrenOf(paint.root).map((child) => child.kind);
  paint.projectAsk(null);
  expect({
    wait: { kinds: waitKinds, face: waitFace },
    both,
    askOnly,
    clear: paintChildrenOf(paint.root).map((child) => child.kind),
  }).toEqual({
    wait: {
      kinds: ["stack", "wait", "composer", "statusline"],
      face: expect.objectContaining({ kind: "wait", name: "waiting", startedAt: 1_000 }),
    },
    both: ["stack", "wait", "ask", "composer", "statusline"],
    askOnly: ["stack", "ask", "composer", "statusline"],
    clear: ["stack", "composer", "statusline"],
  });
  paint[Symbol.dispose]();
});

test("overlay body occupies the painted draft", () => {
  expect(
    paintComposerFace({
      oauthWaiting: false,
      busy: false,
      inputting: false,
      processing: false,
      secret: false,
      isolated: false,
      coverDraft: { draft: "", cursor: 0, mark: null },
      draft: { draft: "/go", cursor: 3, mark: null },
      overlayBody: "Remove work?",
    }).draft,
  ).toBe("Remove work?");
});

test("pin recap marks only the selected user speech", () => {
  const paint = createPaintController(() => undefined);
  const older = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`older`,
    queue: [],
    reducerExited: true,
  });
  const turn = new SessionTurn({
    turnTail: older,
    prompt: prompt.user`pin`,
    queue: [],
    reducerExited: true,
  });
  paint.syncSpine([older, turn]);
  paint.projectPinRecap(turn, "Auth refactor");
  const [tape] = paintChildrenOf(paint.root);
  const recapFaces = (host: typeof tape) =>
    host?.kind === "stack"
      ? paintChildrenOf(host).map((child) => {
          const speech = paintChildrenOf(child).at(0);
          return speech?.kind === "speech" ? { recap: speech.recap, annotation: speech.annotation } : null;
        })
      : [];
  const faces = recapFaces(tape);
  paint.projectPinRecap(null);
  const cleared = recapFaces(tape);
  expect({ faces, cleared }).toEqual({
    faces: [
      { recap: false, annotation: "" },
      { recap: true, annotation: "Auth refactor" },
    ],
    cleared: [
      { recap: false, annotation: "" },
      { recap: false, annotation: "" },
    ],
  });
  paint[Symbol.dispose]();
});

test("a sitting steer paints as an upcoming user prompt, then stays after claim", () => {
  const plexus = SessionPlexus.create("s-steer-paint", "/tmp/steer-paint");
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`map the repo`,
    queue: [],
  });
  plexus.root.head = turn;
  const paint = createPaintController(() => undefined);
  const sync = (): void => {
    paint.syncSpine([turn], plexus.root.steerQueue);
  };
  sync();
  admitQueue(plexus.root, prompt.user`later`, turn.uuid);
  admitSteer(plexus.root, prompt.user`keep AUTH_SECRET out`, turn.uuid);
  sync();
  const sitting = turnChildren(paint).map((child) =>
    child.kind === "speech" ? { voice: child.voice, text: child.text } : child.kind,
  );
  const sittingRows = plexus.root.steerQueue.splice(0);
  const claimed = sittingRows.map((row) => {
    const cell = new TurnSteerChunk({
      text: row.text,
      derivedMessage: row.derivedMessage,
      composedAtMs: row.composedAtMs,
      composedAgainst: row.composedAgainst,
    });
    turn.doneWork.push(cell);
    return cell;
  });
  sync();
  const after = turnChildren(paint).map((child) =>
    child.kind === "speech" ? { voice: child.voice, text: child.text } : child.kind,
  );
  expect({
    sitting,
    claimed: claimed.map((cell) => cell.steerText()),
    deck: plexus.root.steerQueue.map((row) => row.text),
    after,
  }).toEqual({
    sitting: [
      { voice: "user", text: "map the repo" },
      { voice: "user", text: "keep AUTH_SECRET out" },
    ],
    claimed: ["keep AUTH_SECRET out"],
    deck: [],
    after: [
      { voice: "user", text: "map the repo" },
      { voice: "user", text: "keep AUTH_SECRET out" },
    ],
  });
  expect(turn.doneWork.some((chunk) => chunk instanceof TurnSteerChunk)).toBe(true);
  paint[Symbol.dispose]();
  plexus.destroy();
});

test("a speech token updates the replica without a spine resync", async () => {
  const posted: PaintDownMessage[] = [];
  const paint = createPaintController((message) => posted.push(message));
  const chunk = new CompletionExpectation({ connectionId: "c", model: "m" });
  chunk.responseText = "hi";
  chunk.outcome = "successful";
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [new CompletionJob({ expectation: chunk })],
    queue: [],
  });
  paint.syncSpine([turn]);
  paint.attach();
  await flush();
  const afterInit = posted.length;
  chunk.responseText = "hi!";
  await flush();
  const reader = createPaintReader();
  for (const message of posted) reader.apply(message);
  const tape = paintChildrenOf(reader.root!).at(0);
  const turnNode = tape?.kind === "stack" ? paintChildrenOf(tape).at(0) : undefined;
  const completion = turnNode === undefined ? undefined : paintChildrenOf(turnNode).at(1);
  expect({
    patched: posted.length > afterInit,
    speech: completion?.kind === "completion" ? speechOf(completion).text : completion?.kind,
  }).toEqual({ patched: true, speech: "hi!" });
  reader.dispose();
  paint[Symbol.dispose]();
});

test("a speech token does not patch sealed tool faces", async () => {
  const posted: PaintDownMessage[] = [];
  const paint = createPaintController((message) => posted.push(message));
  const chunk = new CompletionExpectation({ connectionId: "c", model: "m" });
  chunk.responseText = "hi";
  chunk.outcome = "successful";
  const prior = Array.from({ length: 80 }, (_, i) => `export const x${i} = ${i};`).join("\n");
  const edit = new FileMutateToolJob({
    toolCallId: "e",
    name: "edit_file",
    argsJson: JSON.stringify({
      path: "a.ts",
      old_string: "export const x0 = 0;",
      new_string: "export const x0 = 1;",
    }),
    priorContent: prior,
    completed: true,
    outcomeJson: JSON.stringify({ ok: true, value: "edited" }),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [new CompletionJob({ expectation: chunk }), edit],
    queue: [],
  });
  paint.syncSpine([turn]);
  paint.attach();
  await flush();
  const afterInit = posted.length;
  chunk.responseText = "hi!";
  paint.syncSpine([turn]);
  await flush();
  const paths = posted
    .slice(afterInit)
    .flatMap((item) => (item.kind === "paint_patch" ? item.patches.map((patch) => patch.path) : []));
  expect({
    speech: paths.some((path) => path.includes("text")),
    diffOld: paths.some((path) => path.includes("diffOld")),
    receipt: paths.some((path) => path.includes("receiptText")),
  }).toEqual({ speech: true, diffOld: false, receipt: false });
  paint[Symbol.dispose]();
});

test("a cell with a blob prior repaints when its text lands, and a landing for another blob leaves it alone", async () => {
  const sha = "a".repeat(64);
  const other = "b".repeat(64);
  const file = Array.from({ length: 80 }, (_, i) => `export const x${i} = ${i};`).join("\n");
  // A reactive cache like Tea's: a peek reads the entry for its hash, a landing writes it.
  const landed = observable.map<string, number>([], { deep: false });
  const texts = new Map<string, string>();
  const asked: string[] = [];
  const blobs: BlobPeek = {
    peek: (hash) => {
      landed.get(hash);
      return texts.get(hash) ?? null;
    },
    want: (hash) => {
      asked.push(hash);
    },
  };
  const land = (hash: string, text: string): void => {
    texts.set(hash, text);
    runInAction(() => landed.set(hash, (landed.get(hash) ?? 0) + 1));
  };
  const posted: PaintDownMessage[] = [];
  const paint = createPaintController((message) => posted.push(message), "paint", { blobs });
  const edit = new FileMutateToolJob({
    toolCallId: "e",
    name: "edit_file",
    argsJson: JSON.stringify({
      path: "a.ts",
      old_string: "export const x0 = 0;",
      new_string: "export const x0 = 1;",
    }),
    priorBlobJson: storedBlobJson({ sha256: sha, bytes: file.length, mime: "text/plain", head: file.slice(0, 64) }),
    completed: true,
    outcomeJson: JSON.stringify({ ok: true, value: "edited" }),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [edit],
    queue: [],
  });
  paint.syncSpine([turn]);
  paint.attach();
  await flush();
  expect(asked).toEqual([sha]);
  const pathsSince = (from: number): string[] =>
    posted.slice(from).flatMap((item) => (item.kind === "paint_patch" ? item.patches.map((patch) => patch.path) : []));

  const afterInit = posted.length;
  land(other, "some other file");
  await flush();
  expect(pathsSince(afterInit).some((path) => path.includes("diffOld"))).toBe(false);

  const beforeLanding = posted.length;
  land(sha, file);
  await flush();
  const patched = posted
    .slice(beforeLanding)
    .flatMap((item) => (item.kind === "paint_patch" ? item.patches : []))
    .filter((patch) => patch.path.includes("diffOld") || patch.path.includes("diffNew"));
  expect(patched.map((patch) => patch.path.split("/").at(-1)).toSorted()).toEqual(["diffNew", "diffOld"]);
  expect(JSON.stringify(patched)).toContain("export const x79 = 79;");
  // The text is in hand now, so the face does not ask again.
  expect(asked).toEqual([sha]);
  paint[Symbol.dispose]();
});
