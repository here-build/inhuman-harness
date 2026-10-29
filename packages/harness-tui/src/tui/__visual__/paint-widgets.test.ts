import { createPaintLocal, writePaintEcho } from "@inhuman.tools/quickdraw/runtime";
import type { SyntaxPolarity } from "@inhuman.tools/quickdraw/widgets";
import { runInAction } from "mobx";
import { expect, test } from "vitest";

import {
  createCompletion,
  createComposer,
  createPaintRoot,
  createPreview,
  createSpeech,
  createStack,
  createTurn,
  createWorkCell,
  failureOf,
  speechOf,
  thinkingOf,
  type CompletionPaintInstance,
  type TurnPaintInstance,
} from "../paint-dom.js";
import { createHarnessPaintSource } from "../paint-source.js";
import { createPaintReader, createPaintWriter, type PaintDownMessage } from "../paint-transport.js";
import { CompletionWidget, SpeechWidget, createPaintWidgetHost } from "../paint-widgets.js";
import { SPINNER_PHASE } from "../spinner-phase.js";

async function flushMicrotask(): Promise<void> {
  await Promise.resolve();
}

function replica(): {
  writerRoot: ReturnType<typeof createPaintRoot>;
  reader: ReturnType<typeof createPaintReader>;
  posted: PaintDownMessage[];
  apply: () => Promise<void>;
} {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const writerRoot = createPaintRoot();
  const turn = createTurn();
  turn.appendChild(createCompletion({ workerPresent: true, model: "m" }));
  writerRoot.appendChild(turn);
  writerRoot.appendChild(createComposer());
  writer.attach(writerRoot);
  const reader = createPaintReader();
  reader.apply(posted[0]!);
  return {
    writerRoot,
    reader,
    posted,
    apply: async () => {
      await flushMicrotask();
      const last = posted[posted.length - 1];
      if (last !== undefined && last.kind === "paint_patch") reader.apply(last);
    },
  };
}

function writerCompletion(root: ReturnType<typeof createPaintRoot>): CompletionPaintInstance {
  const turn = root.children[0] as TurnPaintInstance;
  return turn.children[0] as CompletionPaintInstance;
}

function readerCompletion(reader: ReturnType<typeof createPaintReader>): CompletionPaintInstance {
  const turn = reader.root!.children[0] as TurnPaintInstance;
  return turn.children[0] as CompletionPaintInstance;
}

function walkTexts(node: unknown, texts: string[] = []): string[] {
  if (typeof node !== "object" || node === null) return texts;
  const rec = node as { content?: unknown; summary?: unknown; children?: unknown[] };
  if (typeof rec.content === "string") texts.push(rec.content);
  if (rec.summary !== undefined) walkTexts(rec.summary, texts);
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) walkTexts(child, texts);
  }
  return texts;
}

function walkKeys(node: unknown, keys: string[] = []): string[] {
  if (typeof node !== "object" || node === null) return keys;
  const rec = node as { key?: string; draft?: string; children?: unknown[] };
  if (typeof rec.key === "string") keys.push(rec.key);
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) walkKeys(child, keys);
  }
  return keys;
}

function findDraft(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const rec = node as { key?: string; draft?: string; children?: unknown[] };
  if (rec.key === "composer:frame" && typeof rec.draft === "string") return rec.draft;
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const hit = findDraft(child);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function chromeFramesOf(node: unknown): Array<{
  key?: string;
  contourRole?: string;
  modHeld?: boolean;
  statusItems?: unknown;
  quotaWindows?: unknown;
}> {
  if (typeof node !== "object" || node === null) return [];
  const rec = node as { type?: unknown; children?: unknown };
  const self =
    rec.type === "chrome_frame"
      ? [
          rec as {
            key?: string;
            contourRole?: string;
            modHeld?: boolean;
            statusItems?: unknown;
            quotaWindows?: unknown;
          },
        ]
      : [];
  if (!Array.isArray(rec.children)) return self;
  return self.concat(rec.children.flatMap((child) => chromeFramesOf(child)));
}

function hasLiveChrome(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const rec = node as { live?: unknown; children?: unknown[] };
  if (rec.live !== undefined) return true;
  if (!Array.isArray(rec.children)) return false;
  return rec.children.some((child) => hasLiveChrome(child));
}

test("prepare hits the cache at the same offered width", () => {
  const { reader } = replica();
  let paints = 0;
  const host = createPaintWidgetHost(
    {
      requestPaint: () => {
        paints += 1;
      },
    },
    () => "dark",
    () => true,
  );
  const speech = host.widgetFor(speechOf(readerCompletion(reader))) as SpeechWidget;
  const first = speech.prepare(40);
  const second = speech.prepare(40);
  const resized = speech.prepare(20);
  expect({
    cached: second === first,
    expands: speech.expands,
    resized: { same: resized === first, width: resized.width, expands: speech.expands },
    paintReady: first.root.paintReady,
    paints,
  }).toEqual({
    cached: true,
    expands: 2,
    resized: { same: false, width: 20, expands: 2 },
    paintReady: true,
    paints: 0,
  });
});

test("debugNote paints as a muted recall row, including tool-only rounds", () => {
  const { reader } = replica();
  const completion = readerCompletion(reader);
  speechOf(completion).updateText("ok");
  completion.setDebugNote("cache miss · expected hit · 0 cached");
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const turn = reader.root!.children[0] as TurnPaintInstance;
  const withSpeech = JSON.stringify(host.widgetFor(turn).prepare(40).root);
  speechOf(completion).updateText("");
  completion.setState("successful");
  completion.setDebugNote("cache hit · unexpected · 12 cached");
  const toolOnly = JSON.stringify(host.widgetFor(turn).prepare(40).root);
  expect({
    withSpeech: withSpeech.includes("cache miss · expected hit · 0 cached"),
    toolOnly: toolOnly.includes("cache hit · unexpected · 12 cached"),
  }).toEqual({
    withSpeech: true,
    toolOnly: true,
  });
});

test("a token dirties speech and expands once more", async () => {
  const { writerRoot, reader, apply } = replica();
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const speech = host.widgetFor(speechOf(readerCompletion(reader))) as SpeechWidget;
  speech.prepare(48);
  speechOf(writerCompletion(writerRoot)).updateText("hello **world**");
  await apply();
  const next = speech.prepare(48);
  expect({
    expands: speech.expands,
    width: next.width,
    paintReady: next.root.paintReady,
  }).toEqual({
    expands: 2,
    width: 48,
    paintReady: true,
  });
});

test("a speech token rebuilds speech and leaves thinking, composer, and a sealed tool cached", async () => {
  const { writerRoot, reader, apply } = replica();
  const writerTurn = writerRoot.children[0] as TurnPaintInstance;
  const tool = createWorkCell("tool");
  tool.setFace({
    name: "read_file",
    object: "a.ts",
    status: "ok",
    state: "ok",
    indent: false,
    receiptKind: "text",
    receiptText: "done",
    diffOld: "",
    diffNew: "",
    diffPath: "",
  });
  writerTurn.appendChild(tool);
  await apply();

  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const completion = readerCompletion(reader);
  const speech = host.widgetFor(speechOf(completion)) as SpeechWidget;
  const thinking = host.widgetFor(thinkingOf(completion));
  const readerTurn = reader.root!.children[0] as TurnPaintInstance;
  const readerTool = readerTurn.children.find((child) => child.kind === "tool");
  const readerComposer = reader.root!.children.find((child) => child.kind === "composer");
  if (readerTool === undefined || readerComposer === undefined) throw new Error("missing sibling");
  const thinkingFirst = thinking.prepare(48);
  const toolFirst = host.widgetFor(readerTool).prepare(48);
  const composerFirst = host.widgetFor(readerComposer).prepare(48);
  speech.prepare(48);

  const source = createHarnessPaintSource({ reader });
  source.bind({ requestPaint: () => undefined }, createPaintLocal());
  speechOf(writerCompletion(writerRoot)).updateText("hello **world**");
  await apply();
  source.noteReplica("paint_patch");
  const thinkingNext = thinking.prepare(48);
  const toolNext = host.widgetFor(readerTool).prepare(48);
  const composerNext = host.widgetFor(readerComposer).prepare(48);
  const speechNext = speech.prepare(48);
  source.prepare();

  expect({
    expands: speech.expands,
    width: speechNext.width,
    thinking: thinkingNext === thinkingFirst,
    tool: toolNext === toolFirst,
    composer: composerNext === composerFirst,
  }).toEqual({
    expands: 2,
    width: 48,
    thinking: true,
    tool: true,
    composer: true,
  });
});

test("speech-seal lifecycle: fail keeps widgets; success ends the stream once", async () => {
  const { writerRoot, reader, apply } = replica();
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const completionNode = readerCompletion(reader);
  const completion = host.widgetFor(completionNode) as CompletionWidget;
  const speech = host.widgetFor(speechOf(completionNode)) as SpeechWidget;
  speechOf(writerCompletion(writerRoot)).updateText("keep");
  await apply();
  const live = speech.prepare(48);
  const liveOracle = {
    expands: speech.expands,
    birth: live.birthSites,
    completion: host.widgetFor(completionNode) === completion,
    speech: host.widgetFor(speechOf(completionNode)) === speech,
  };

  writerCompletion(writerRoot).setState("failed");
  failureOf(writerCompletion(writerRoot)).updateEndDetail("boom");
  await apply();
  completion.prepare(48);
  const failed = {
    expands: speech.expands,
    completion: host.widgetFor(completionNode) === completion,
    speech: host.widgetFor(speechOf(completionNode)) === speech,
  };

  writerCompletion(writerRoot).setState("successful");
  await apply();
  const sealed = speech.prepare(48);
  writerCompletion(writerRoot).setWorkerPresent(false);
  await apply();
  speech.prepare(48);
  expect({
    live: liveOracle,
    failed,
    sealed: { expands: speech.expands, birth: sealed.birthSites },
  }).toEqual({
    live: { expands: 1, birth: [], completion: true, speech: true },
    failed: { expands: 1, completion: true, speech: true },
    sealed: { expands: 2, birth: [] },
  });
});

test("syntax polarity miss rebuilds markdown without a text change", () => {
  const { reader } = replica();
  let polarity: SyntaxPolarity = "dark";
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => polarity,
    () => true,
  );
  const speech = host.widgetFor(speechOf(readerCompletion(reader))) as SpeechWidget;
  speech.prepare(32);
  polarity = "light";
  speech.markDirty();
  speech.prepare(32);
  expect(speech.expands).toBe(2);
});

test("thinking collapse dirties thinking without remounting the completion", () => {
  const { reader } = replica();
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const completionNode = readerCompletion(reader);
  const completion = host.widgetFor(completionNode);
  const thinking = host.widgetFor(thinkingOf(completionNode));
  completion.prepare(40);
  const local = host.localFor(thinkingOf(completionNode));
  host.toggleCollapsed(local.hitKey);
  const prepared = thinking.prepare(40);
  expect({
    completion: host.widgetFor(completionNode) === completion,
    thinking: host.widgetFor(thinkingOf(completionNode)) === thinking,
    paintReady: prepared.root.paintReady,
  }).toEqual({
    completion: true,
    thinking: true,
    paintReady: true,
  });
});

test("toggleCollapsed via paint:N:thought flips the thinking node's collapse", () => {
  const { reader } = replica();
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const thinking = thinkingOf(readerCompletion(reader));
  const local = host.localFor(thinking);
  host.toggleCollapsed(`${local.hitKey}:thought`);
  const afterThought = local.collapsed;
  host.toggleCollapsed(`${local.hitKey}:thought:hdr`);
  const afterHdr = local.collapsed;
  host.toggleCollapsed("paint:999:thought");
  expect({
    hitKey: /^paint:\d+$/.test(local.hitKey),
    afterThought,
    afterHdr,
    unknown: local.collapsed,
  }).toEqual({
    hitKey: true,
    afterThought: false,
    afterHdr: true,
    unknown: true,
  });
});

test("composer widget walk: width, picker, echo, quota hold", () => {
  const { reader } = replica();
  const local = createPaintLocal();
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
    local,
  );
  const composer = reader.root!.children[1];
  if (composer === undefined || composer.kind !== "composer") throw new Error("composer");
  const widget = host.widgetFor(composer);
  const prepared = widget.prepare(60);
  const width = {
    width: prepared.width,
    measured: prepared.measured.w > 0,
    paintReady: prepared.root.paintReady,
    cached: widget.prepare(60) === prepared,
  };

  composer.setCommandChoices([{ key: "c1", name: "/connect", actions: [] }]);
  composer.setDraft("hello");
  widget.markDirty();
  const withPicker = walkKeys(widget.prepare(48).root);

  composer.setCommandChoices(null);
  composer.setStackedBody(["recipient  ada@example.com", "subject  Invoice 1042"].join("\n"));
  composer.setStackedViewport(8);
  composer.setContourRole("emphasis");
  widget.markDirty();
  const withConfirm = widget.prepare(48);
  const confirmKeys = walkKeys(withConfirm.root);
  const confirmDump = JSON.stringify(withConfirm.root);
  const confirmContours = chromeFramesOf(withConfirm.root).map((frame) => ({
    key: frame.key,
    contourRole: frame.contourRole,
  }));

  writePaintEcho(local, { predicted: { draft: "hello!", cursor: 6, mark: null }, misaligned: false });
  widget.markDirty();
  const echoed = findDraft(widget.prepare(48).root);

  composer.setStatusItems(["gpt-5.4", "ChatGPT"]);
  composer.setQuotaWindows([{ remainingPercent: 67, resetAt: 90 * 60 }]);
  widget.markDirty();
  const idle = chromeFramesOf(widget.prepare(80).root).find((frame) => frame.modHeld !== undefined) ?? {};
  runInAction(() => {
    local.modHeld = true;
  });
  widget.markDirty();
  const held =
    chromeFramesOf(widget.prepare(80).root).find((frame) => frame.quotaWindows !== undefined) ??
    chromeFramesOf(widget.prepare(80).root).find((frame) => frame.modHeld === true) ??
    {};

  expect({
    width,
    picker: {
      slash: withPicker.includes("slash-complete"),
      frame: withPicker.includes("composer:frame"),
    },
    confirm: {
      slash: confirmKeys.includes("slash-complete"),
      recipient: confirmDump.includes("recipient"),
      invoice: confirmDump.includes("Invoice 1042"),
      contours: confirmContours,
    },
    echoed,
    quota: {
      idleHeld: idle?.modHeld === true,
      heldFlag: held?.modHeld === true,
      heldWindows: held?.quotaWindows,
    },
  }).toEqual({
    width: { width: 60, measured: true, paintReady: true, cached: true },
    picker: { slash: true, frame: true },
    confirm: {
      slash: true,
      recipient: true,
      invoice: true,
      contours: [
        { key: "slash-complete", contourRole: "emphasis" },
        { key: "composer:frame", contourRole: "emphasis" },
      ],
    },
    echoed: "hello!",
    quota: {
      idleHeld: false,
      heldFlag: true,
      heldWindows: [{ remainingPercent: 67, resetAt: 5400 }],
    },
  });
});

test("ask pin prepare expands Diff before paintReady", () => {
  const cell = createWorkCell("ask");
  cell.setFace({
    name: "edit_file",
    object: "src/hello.ts",
    status: "",
    state: "ask",
    indent: false,
    split: false,
    receiptKind: "diff",
    receiptText: "",
    diffOld: 'export function greet() {\n  return "hello";\n}',
    diffNew: 'export function greet() {\n  return "hi, world";\n}',
    diffPath: "src/hello.ts",
  });
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const prepared = host.widgetFor(cell).prepare(40);
  const dumped = JSON.stringify(prepared.root);
  expect({
    paintReady: prepared.root.paintReady,
    leftoverDiffType: dumped.includes('"type":"diff"'),
  }).toEqual({
    paintReady: true,
    leftoverDiffType: false,
  });
});

test("empty live thought is not a tape row", () => {
  const tape = createStack();
  const turn = createTurn();
  turn.appendChild(createCompletion({ workerPresent: false, thoughtLive: true }));
  tape.appendChild(turn);
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const dumped = JSON.stringify(host.widgetFor(tape).prepare(40).root);
  expect({
    working: dumped.includes("working..."),
    waiting: dumped.includes("waiting for response..."),
  }).toEqual({
    working: false,
    waiting: false,
  });
});

test("wait pin: error takes the right slot; occupancy keeps the spinner", () => {
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const fault = createWorkCell("wait");
  fault.setFace({
    name: "error",
    object: "openai-compat completion failed: 403",
    status: "",
    state: "fail",
    indent: false,
    receiptKind: "none",
    receiptText: "",
    diffOld: "",
    diffNew: "",
    diffPath: "",
    startedAt: 0,
  });
  const both = createWorkCell("wait");
  both.setFace({
    name: "waiting",
    object: "openai-compat completion failed: 403",
    status: "waiting for response...",
    state: "live",
    indent: false,
    receiptKind: "none",
    receiptText: "",
    diffOld: "",
    diffNew: "",
    diffPath: "",
    startedAt: 0,
    retryUntilMs: 5_000,
  });
  const faultDump = JSON.stringify(host.widgetFor(fault).prepare(40).root);
  const bothDump = JSON.stringify(host.widgetFor(both).prepare(40).root);
  expect({
    error: faultDump.includes("openai-compat completion failed: 403"),
    waiting: faultDump.includes("waiting for response..."),
    bothError: bothDump.includes("openai-compat completion failed: 403"),
    bothWaiting: hasLiveChrome(host.widgetFor(both).prepare(40).root),
    spaceBetween: bothDump.includes("space_between"),
  }).toEqual({
    error: true,
    waiting: false,
    bothError: true,
    bothWaiting: true,
    spaceBetween: true,
  });
});

test("wait pin paints a stall phase as its spinner label", () => {
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const cell = createWorkCell("wait");
  cell.setFace({
    name: "waiting",
    object: "",
    status: SPINNER_PHASE.syncingKernel,
    state: "live",
    indent: false,
    receiptKind: "none",
    receiptText: "",
    diffOld: "",
    diffNew: "",
    diffPath: "",
    startedAt: null,
  });
  expect(JSON.stringify(host.widgetFor(cell).prepare(40).root).includes(SPINNER_PHASE.syncingKernel)).toBe(true);
});

test("wait pin: connecting has no elapsed; retry countdown does", () => {
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const boot = createWorkCell("wait");
  boot.setFace({
    name: "connecting",
    object: "",
    status: "connecting...",
    state: "live",
    indent: false,
    receiptKind: "none",
    receiptText: "",
    diffOld: "",
    diffNew: "",
    diffPath: "",
    startedAt: null,
  });
  const retry = createWorkCell("wait");
  retry.setFace({
    name: "waiting",
    object: "",
    status: "waiting for response...",
    state: "live",
    indent: false,
    receiptKind: "none",
    receiptText: "",
    diffOld: "",
    diffNew: "",
    diffPath: "",
    startedAt: 0,
    retryUntilMs: 5_000,
  });
  expect({
    elapsed: hasLiveChrome(host.widgetFor(boot).prepare(40).root),
    retry: hasLiveChrome(host.widgetFor(retry).prepare(40).root),
  }).toEqual({
    elapsed: false,
    retry: true,
  });
});

test.each([
  {
    name: "user speech to work",
    build: () => {
      const tape = createStack();
      const turn = createTurn();
      turn.appendChild(createSpeech("hello from the user", "user"));
      const completion = createCompletion({ workerPresent: true, model: "m" });
      speechOf(completion).updateText("ok");
      turn.appendChild(completion);
      tape.appendChild(turn);
      return tape;
    },
    gaps: { inputWork: true, thoughtAfter: false, toolsAfter: false },
  },
  {
    name: "thought to speech",
    build: () => {
      const tape = createStack();
      const turn = createTurn();
      const completion = createCompletion({ workerPresent: true, model: "m" });
      thinkingOf(completion).updateText("weighing options");
      speechOf(completion).updateText("ok");
      turn.appendChild(completion);
      tape.appendChild(turn);
      return tape;
    },
    gaps: { inputWork: false, thoughtAfter: true, toolsAfter: false },
  },
  {
    name: "tools before speech",
    build: () => {
      const tape = createStack();
      const turn = createTurn();
      const thought = createCompletion({ workerPresent: true, model: "m" });
      thinkingOf(thought).updateText("weighing options");
      const read = createWorkCell("tool");
      read.setFace({
        name: "read_file",
        object: "a.ts",
        status: "",
        state: "ok",
        indent: false,
        split: false,
        receiptKind: "none",
        receiptText: "",
        diffOld: "",
        diffNew: "",
        diffPath: "",
      });
      const write = createWorkCell("tool");
      write.setFace({
        name: "write_file",
        object: "b.ts",
        status: "",
        state: "ok",
        indent: false,
        split: false,
        receiptKind: "none",
        receiptText: "",
        diffOld: "",
        diffNew: "",
        diffPath: "",
      });
      const completion = createCompletion({ workerPresent: true, model: "m" });
      speechOf(completion).updateText("ok");
      turn.appendChild(thought);
      turn.appendChild(read);
      turn.appendChild(write);
      turn.appendChild(completion);
      tape.appendChild(turn);
      return tape;
    },
    gaps: { inputWork: false, thoughtAfter: false, toolsAfter: true },
  },
])("tape stack gap keys: $name", ({ build, gaps }) => {
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
  );
  const keys = walkKeys(host.widgetFor(build()).prepare(40).root);
  expect({
    inputWork: keys.some((key) => key.startsWith("gap:input-work:")),
    thoughtAfter: keys.some((key) => key.startsWith("gap:thought-after:")),
    toolsAfter: keys.some((key) => key.startsWith("gap:tools-after:")),
  }).toEqual(gaps);
});

test("sneak-peek tape keeps fused tools while the host tape is compact", () => {
  const local = createPaintLocal(40, 12);
  local.tapeExpanded = false;
  const host = createPaintWidgetHost(
    { requestPaint: () => undefined },
    () => "dark",
    () => true,
    local,
  );
  const face = {
    name: "read_file",
    object: "peek.ts",
    status: "",
    state: "ok" as const,
    indent: false,
    split: false,
    receiptKind: "text" as const,
    receiptText: "export {}",
    diffOld: "",
    diffNew: "",
    diffPath: "",
    fuse: true,
  };
  const turn = () => {
    const next = createTurn();
    const thought = createCompletion({ workerPresent: true, model: "m" });
    thinkingOf(thought).updateText("looking");
    const read = createWorkCell("tool");
    read.setFace(face);
    const speech = createCompletion({ workerPresent: true, model: "m" });
    speechOf(speech).updateText("ok");
    next.appendChild(thought);
    next.appendChild(read);
    next.appendChild(speech);
    return next;
  };
  const tape = createStack();
  tape.appendChild(turn());
  const preview = createPreview();
  preview.appendChild(turn());
  const hostTexts = walkTexts(host.widgetFor(tape).prepare(40).root).join("\n");
  const peekTexts = walkTexts(host.widgetFor(preview).prepare(40).root).join("\n");
  expect({
    host: hostTexts.includes("peek.ts"),
    peek: peekTexts.includes("peek.ts"),
  }).toEqual({ host: false, peek: true });
});
