import { defaultCommands } from "@inhuman.tools/harness/testkit";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CommandSpec,
  CompletionExpectation,
  CompletionJob,
  KernelPlexus,
  KernelRoot,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import { elementAt, layout, layoutChildren, type LayoutNode } from "@inhuman.tools/quickdraw/layout";
import {
  agentsPanelWidth,
  agentsPreviewInnerWidth,
  assemblePaintFrame,
  createPaintLocal,
  rasterPng,
  rootInnerWidth,
  SCREENSHOT_NOW_MS,
  tapeInnerWidth,
  toggleCollapsedFromHit,
} from "@inhuman.tools/quickdraw/runtime";
import { expandWidgetPriors } from "@inhuman.tools/quickdraw/widgets";
import { runInAction } from "mobx";
import { destroy, getSnapshot } from "mobx-state-tree";

import { agentsPreviewTitle as processPreviewTitle, prepareAgentsMeter, prepareAgentsPeek } from "../agents-drawer.js";
import {
  type AgentsPaintInstance,
  type ComposerPaintInstance,
  isPaintRootChrome,
  paintChildrenOf,
  type PaintNodeInstance,
  type RewindPaintInstance,
  RootPaint,
  type RootPaintInstance,
  type StatuslinePaintInstance,
} from "../paint-dom.js";
import { createHarnessPaintSource, packReplicaRewind } from "../paint-source.js";
import { createPaintReader, type PaintDownMessage } from "../paint-transport.js";
import { createPaintWidgetHost } from "../paint-widgets.js";
import { Tea, type TeaDeps } from "../tea.js";

export type FrameDump = {
  sites: string[];
  size: { width: number; height: number };
  transcript: TranscriptBlock[];
  ask: TranscriptBlock[];
  wait: TranscriptBlock[];
  composer: ComposerDump;
};

export type TranscriptBlock = {
  band?: "input" | "work" | "gap";
  type?: string;
  key?: string;
  role?: string;
  gutter?: unknown;
  collapsed?: boolean;
  texts: string[];
  children?: TranscriptBlock[];
};

export type ComposerDump = {
  draft: string;
  completion: string;
  placeholder: string;
  annotation: string;
  annotationRole: string;
  statusItems: readonly string[];
  quotaWindows: readonly { remainingPercent: number; resetAt?: number }[];
  interactive: boolean;
  hints: string[];
  glyphs: string[];
  texts: string[];
  picker: {
    selectedKey: string | null;
    scrollOffset: number;
    rows: PickerRowDump[];
  };
};

export type PickerRowDump = {
  key?: string;
  name?: string;
  status?: string;
  annotation?: string;
  description?: string;
  actionDisplayName?: string;
  href?: string;
  actions?: Array<{ name?: string; displayName?: string; hotkey?: string }>;
};

export function localClient(): Client {
  // ASK_THROTTLE: product first Enter is inert. Callers that need a live
  // cover must set approvalAskThrottleMs = 0; restoring the default flakes goldens.
  return new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot()),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
}

export type OpenTea = {
  client: Client;
  tea: Tea;
  dump: () => FrameDump;
  screenshot: () => Buffer;
  click(col: number, row: number): void;
  hitOf(needle: string): { col: number; row: number };
  setTapeExpanded(expanded: boolean): void;
  [Symbol.dispose](): void;
};

export type OpenTeaOptions = TeaDeps & {
  /**
   * TAPE_EXPANDED: helper defaults true for identity goldens. Product
   * boots compact; compact shots pass false. Flipping the default dirties
   * identity goldens.
   */
  readonly tapeExpanded?: boolean;
};

export function openTea(client: Client = localClient(), options?: OpenTeaOptions): OpenTea {
  const { tapeExpanded = true, ...deps } = options ?? {};
  const reader = createPaintReader();
  const source = createHarnessPaintSource({ reader });
  const tea = new Tea(
    client,
    (batch: readonly PaintDownMessage[]) => {
      for (const message of batch) {
        reader.apply(message);
        source.noteReplica(message.kind);
      }
    },
    deps,
  );
  const local = createPaintLocal(tea.cols, tea.rows);
  runInAction(() => {
    local.tapeExpanded = tapeExpanded;
  });
  const binding = source.bind({ requestPaint: () => undefined }, local);

  const prepared = () => {
    tea.flushPaint();
    runInAction(() => {
      local.cols = tea.cols;
      local.rows = tea.rows;
    });
    return source.prepare();
  };

  const laidOut = () => {
    const next = prepared();
    if (next.root === null) throw new Error("no paint frame");
    const expanded = expandWidgetPriors(next.root, { width: tea.cols });
    return { expanded, frame: layout(expanded, { w: tea.cols, h: tea.rows }) };
  };

  return {
    client,
    tea,
    dump: () => dumpAssembled(prepared().root, tea.cols, tea.rows),
    screenshot: () => {
      const next = prepared();
      if (next.root === null) throw new Error("screenshot: no paint");
      return rasterPng(next.root, tea.cols, tea.rows);
    },
    click(col, row) {
      const { frame } = laidOut();
      const hit = elementAt(frame, col, row);
      if (hit === null) throw new Error(`click miss at ${col},${row}`);
      const toggle = toggleCollapsedFromHit(hit, frame.byKey);
      if (toggle === null) throw new Error(`click miss collapse at ${col},${row}`);
      source.toggleCollapsed(toggle.blockId);
    },
    hitOf(needle) {
      const { expanded, frame } = laidOut();
      for (const meta of frame.byKey.values()) {
        if (!isCollapsedHit(meta)) continue;
        const node = nodeByKey(expanded, meta.key);
        const texts = collectNodeTexts(node);
        if (texts.some((text) => text.includes(needle))) {
          return { col: meta.hitRect.x, row: meta.hitRect.y };
        }
      }
      throw new Error(`no collapse hit matching ${JSON.stringify(needle)}`);
    },
    setTapeExpanded(expanded) {
      runInAction(() => {
        local.tapeExpanded = expanded;
      });
    },
    [Symbol.dispose](): void {
      binding[Symbol.dispose]();
      reader.dispose();
      tea[Symbol.dispose]();
    },
  };
}

/** Prior user turn — two lines at 80 cols (content starts at column 3). */
export const PRIOR_PROMPT = prompt.user`The login form still posts the previous password hash
after I rotate AUTH_SECRET. Check AuthForm and /login.`;
export const PRIOR_REPLY =
  "AuthForm reads the secret at import time. I'll look it\nup per request and add a rotate regression.";
export const PRIOR_THOUGHT =
  "401 is the old hash. AuthForm imports AUTH_SECRET\nwhen the module loads, so rotate never reaches POST.";

export function sealedCompletion(fields?: {
  prompt?: string;
  text?: string;
  thought?: string | null;
  connectionId?: string;
  outcome?: "successful" | "failed";
  endDetail?: string;
}): CompletionExpectation {
  const completion = new CompletionExpectation({
    promptText: prompt.user`${fields?.prompt ?? PRIOR_PROMPT}`,
    connectionId: fields?.connectionId ?? "c",
  });
  completion.responseText = fields?.text ?? PRIOR_REPLY;
  if (fields?.thought !== null) {
    completion.responseThought = fields?.thought ?? PRIOR_THOUGHT;
  }
  completion.outcome = fields?.outcome ?? "successful";
  if (fields?.endDetail !== undefined) completion.endDetail = fields.endDetail;
  completion.markStarted(SCREENSHOT_NOW_MS);
  completion.markThoughtEnded(SCREENSHOT_NOW_MS);
  return completion;
}

export function seatTurn(
  fields: Omit<Exclude<ConstructorParameters<typeof SessionTurn>[0], symbol | undefined>, "prompt"> & {
    prompt: string;
  },
): SessionTurn {
  const turn = new SessionTurn({
    ...fields,
    prompt: prompt.user`${fields.prompt}`,
  });
  turn.markStarted(SCREENSHOT_NOW_MS);
  return turn;
}

export function wrapTurn(
  completion: CompletionExpectation,
  turnTail: SessionSystemPrompt | SessionTurn = new SessionSystemPrompt(),
): SessionTurn {
  const turn = seatTurn({
    turnTail,
    prompt: completion.promptText,
    doneWork: [new CompletionJob({ expectation: completion })],
    queue: [],
    reducerExited: completion.outcome != null,
  });
  if (completion.startedAtMs == null) completion.markStarted(SCREENSHOT_NOW_MS);
  completion.markThoughtEnded(SCREENSHOT_NOW_MS);
  return turn;
}

/** Seat a sealed exchange so chrome goldens are not an empty tape. */
export function seedConversation(client: Client): SessionTurn {
  const turn = wrapTurn(
    sealedCompletion({
      thought: null,
    }),
  );
  turn.reducerExited = true;
  client.sessionRoot.head = turn;
  return turn;
}

export function talkingClient(): Client {
  const client = localClient();
  seedConversation(client);
  return client;
}

export function defaultCommandSpec(verb: "connect" | "model" | "mcp"): CommandSpec {
  const rec = defaultCommands().find((row) => row.verb === verb);
  if (rec === undefined) throw new Error(`missing default command ${verb}`);
  return new CommandSpec({
    verb: rec.verb,
    description: rec.description,
    source: rec.source,
    body: rec.body,
  });
}

export function typeText(tea: Tea, text: string): void {
  tea.handle({ kind: "input_events", events: [...text].map((key) => ({ key })) });
}

export function press(tea: Tea, key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): void {
  tea.handle({ kind: "input_events", events: [{ key, ...mods }] });
}

/**
 * Snapshot the write tree, prepare through WidgetHost, then destroy the
 * replica. Do not widgetFor Tea.paintRoot — that would addDisposer on live nodes.
 */
export function dumpPaint(tea: Tea): FrameDump {
  const prepared = preparePaint(tea);
  try {
    const sites: string[] = [];
    if (prepared.tape !== null) sites.push("transcript");
    if (prepared.ask !== null) sites.push("ask");
    if (prepared.wait !== null) sites.push("wait");
    if (prepared.composer !== null) sites.push("composer");
    sites.sort();
    return {
      sites,
      size: { width: tea.cols, height: tea.rows },
      transcript: dumpTranscript(prepared.tapeNode),
      ask: dumpTranscript(prepared.askNode),
      wait: dumpTranscript(prepared.waitNode),
      composer: dumpComposer(prepared.composerNode),
    };
  } finally {
    prepared[Symbol.dispose]();
  }
}

/**
 * Product column as a truecolor PNG. Frozen clock. Same prepare as dumpPaint.
 */
export function screenshot(tea: Tea, opts?: { atBottom?: boolean; scroll?: number }): Buffer {
  const prepared = preparePaint(tea);
  try {
    const root = assemblePaintFrame({
      tape: prepared.tapeNode ?? { type: "box", key: "transcript", children: [] },
      composer: prepared.composerNode ?? { type: "box", key: "composer", children: [] },
      ask: prepared.askNode,
      wait: prepared.waitNode,
      agentsMeter: prepared.agentsMeter,
      agents: prepared.agentsNode,
      agentsScroll: prepared.agentsScroll,
      agentsPeek: prepared.agentsPeek,
      agentsFocusKey: prepared.agentsFocusKey,
      agentsPreview: prepared.agentsPreview,
      agentsPreviewTitle: prepared.agentsPreviewTitle,
      statusline:
        prepared.statusline === null ? null : { left: prepared.statusline.left, cwd: prepared.statusline.cwd },
      cols: tea.cols,
      rows: tea.rows,
      atBottom: opts?.atBottom,
      scroll: opts?.scroll,
      atTip: prepared.rewind.atTip,
      seatRim: prepared.rewind.seatRim,
      pastNeighbors: prepared.rewind.pastNeighbors,
      futureNeighbors: prepared.rewind.futureNeighbors,
    });
    return rasterPng(root, tea.cols, tea.rows);
  } finally {
    prepared[Symbol.dispose]();
  }
}

export function preparePaint(tea: Tea): {
  tape: PaintNodeInstance | null;
  ask: PaintNodeInstance | null;
  wait: PaintNodeInstance | null;
  composer: ComposerPaintInstance | null;
  statusline: { cwd: string; left: string } | null;
  tapeNode: LayoutNode | null;
  askNode: LayoutNode | null;
  waitNode: LayoutNode | null;
  composerNode: LayoutNode | null;
  agentsMeter: LayoutNode | null;
  agentsNode: LayoutNode | null;
  agentsScroll: number;
  agentsPeek: LayoutNode | null;
  agentsFocusKey: string;
  agentsPreview: LayoutNode | null;
  agentsPreviewTitle: string;
  rewind: ReturnType<typeof packReplicaRewind>;
  [Symbol.dispose](): void;
} {
  const replica = RootPaint.create(getSnapshot(tea.paintRoot));
  const frameW = rootInnerWidth(tea.cols);
  const tapeW = tapeInnerWidth(tea.cols);
  const host = createPaintWidgetHost({ requestPaint: () => undefined });
  const tape = tapeOf(replica);
  const ask = askOf(replica);
  const wait = waitOf(replica);
  const composer = composerOf(replica);
  const statusline = statuslineOf(replica);
  const agents = agentsOf(replica);
  const askW =
    ask !== null && ask.kind === "ask" && (ask as { receiptKind?: string }).receiptKind === "diff" ? tapeW : frameW;
  const drawerOpen = agents?.open === true;
  const drawerW = agentsPanelWidth(tea.cols);
  const preview = previewOf(replica);
  const previewW = agentsPreviewInnerWidth(tea.cols);
  const composerPrepared = composer === null ? null : host.widgetFor(composer).prepare(frameW);
  const askPrepared = ask === null ? null : host.widgetFor(ask).prepare(askW);
  const waitPrepared = wait === null ? null : host.widgetFor(wait).prepare(frameW);
  const agentsMeter =
    agents !== null && (agents.meterLeft !== "" || agents.meterRight !== "")
      ? prepareAgentsMeter(agents.meterLeft, agents.meterRight, frameW)
      : null;
  const askInTape = ask !== null && ask.kind === "ask" && (ask as { receiptKind?: string }).receiptKind === "diff";
  const rewindNode = rewindOf(replica);
  const seatRim = rewindNode == null ? true : rewindNode.seatRim;
  const rewind = packReplicaRewind({
    rewind: rewindNode,
    tapeW,
    rows: tea.rows,
    composerH: seatRim ? (composerPrepared?.measured.h ?? 0) : 0,
    pinH: (askInTape ? 0 : (askPrepared?.measured.h ?? 0)) + (ask === null ? (waitPrepared?.measured.h ?? 0) : 0),
    overviewH: agentsMeter === null ? 0 : 1,
  });
  return {
    tape,
    ask,
    wait,
    composer,
    statusline: statusline === null ? null : { cwd: statusline.cwd, left: statusline.left },
    tapeNode: tape === null ? null : host.widgetFor(tape).prepare(tapeW).root,
    askNode: askPrepared?.root ?? null,
    waitNode: waitPrepared?.root ?? null,
    composerNode: composerPrepared?.root ?? null,
    agentsMeter,
    agentsNode: drawerOpen && agents !== null ? host.widgetFor(agents).prepare(drawerW).root : null,
    agentsScroll: agents?.scroll ?? 0,
    agentsPeek:
      drawerOpen && agents !== null
        ? prepareAgentsPeek({
            meterLeft: agents.meterLeft,
            meterRight: agents.meterRight,
            open: agents.open,
            focusKey: agents.focusKey,
            scroll: agents.scroll,
            rows: agents.rows,
            previewKey: agents.previewKey,
          })
        : null,
    agentsFocusKey: agents?.focusKey ?? "",
    agentsPreview: preview === null ? null : host.widgetFor(preview).prepare(previewW).root,
    agentsPreviewTitle:
      agents == null
        ? ""
        : processPreviewTitle({
            previewKey: agents.previewKey,
            rows: agents.rows,
          }),
    rewind,
    [Symbol.dispose]() {
      destroy(replica);
    },
  };
}

function dumpAssembled(root: LayoutNode | null, cols: number, rows: number): FrameDump {
  const { tape, ask, wait, composer } = splitAssembled(root);
  const sites: string[] = [];
  if (tape !== null) sites.push("transcript");
  if (ask !== null) sites.push("ask");
  if (wait !== null) sites.push("wait");
  if (composer !== null) sites.push("composer");
  sites.sort();
  return {
    sites,
    size: { width: cols, height: rows },
    transcript: dumpTranscript(tape),
    ask: dumpTranscript(ask),
    wait: dumpTranscript(wait),
    composer: dumpComposer(composer),
  };
}

function splitAssembled(root: LayoutNode | null): {
  tape: LayoutNode | null;
  ask: LayoutNode | null;
  wait: LayoutNode | null;
  composer: LayoutNode | null;
} {
  let tape: LayoutNode | null = null;
  let ask: LayoutNode | null = null;
  let wait: LayoutNode | null = null;
  let composer: LayoutNode | null = null;
  const walk = (node: LayoutNode): void => {
    const kids = layoutChildren(node);
    if (node.key === "transcript:viewport") {
      tape = kids[0] ?? null;
      const diff = kids[1];
      if (diff?.key === "ask:diff") {
        ask = layoutChildren(diff)[0] ?? null;
      }
    }
    if (node.key === "ask:pin") {
      ask = kids[0] ?? null;
    }
    if (node.key === "wait:pin") {
      wait = kids[0] ?? null;
    }
    if (node.key === "rim") {
      composer = kids[0] ?? null;
    }
    for (const child of kids) walk(child);
  };
  if (root !== null) walk(root);
  if (composer === null && tape !== null) composer = recapInNode(tape);
  return { tape, ask, wait, composer };
}

function recapInNode(node: LayoutNode): LayoutNode | null {
  if (node.type === "chrome_frame" && node.readOnly === true && node.key?.endsWith(":recap")) return node;
  for (const child of layoutChildren(node)) {
    const hit = recapInNode(child);
    if (hit !== null) return hit;
  }
  return null;
}

function isCollapsedHit(meta: { onClick?: unknown; element?: { kind: string } }): boolean {
  const click = meta.onClick;
  if (typeof click === "object" && click !== null && (click as { type?: unknown }).type === "toggle_collapsed") {
    return true;
  }
  return meta.element?.kind === "disclosure";
}

function nodeByKey(node: unknown, key: string): unknown {
  if (typeof node !== "object" || node === null) return undefined;
  const rec = node as { key?: unknown; summary?: unknown; children?: unknown };
  if (rec.key === key) return node;
  if (rec.summary !== undefined) {
    const nested = nodeByKey(rec.summary, key);
    if (nested !== undefined) return nested;
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const nested = nodeByKey(child, key);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function previewOf(root: RootPaintInstance): PaintNodeInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "preview") return child;
  }
  return null;
}

function rewindOf(root: RootPaintInstance): RewindPaintInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "rewind") return child;
  }
  return null;
}

function agentsOf(root: RootPaintInstance): AgentsPaintInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "agents") return child;
  }
  return null;
}

function tapeOf(root: RootPaintInstance): PaintNodeInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (!isPaintRootChrome(child.kind)) return child;
  }
  return null;
}

function askOf(root: RootPaintInstance): PaintNodeInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "ask") return child;
  }
  return null;
}

function waitOf(root: RootPaintInstance): PaintNodeInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "wait") return child;
  }
  return null;
}

function composerOf(root: RootPaintInstance): ComposerPaintInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "composer") return child;
  }
  return null;
}

function statuslineOf(root: RootPaintInstance): StatuslinePaintInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "statusline") return child;
  }
  return null;
}

export async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function waitDump(dump: () => FrameDump, pred: (frame: FrameDump) => boolean): Promise<FrameDump> {
  await waitFor(() => pred(dump()));
  return dump();
}

export function findDisclosure(blocks: TranscriptBlock[]): TranscriptBlock | undefined {
  for (const block of blocks) {
    if (block.type === "disclosure") return block;
    if (block.children !== undefined) {
      const nested = findDisclosure(block.children);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function dumpKinds(transcript: TranscriptBlock[]): string[] {
  return transcript
    .filter((block) => block.band !== "gap")
    .map((block) => {
      if (block.band === "input" || block.type === "speech") return "speech";
      return block.type ?? "unknown";
    });
}

export function dumpTexts(blocks: TranscriptBlock[]): string {
  return blocks.flatMap((block) => block.texts).join("\n");
}

export function normalizeDump(frame: FrameDump) {
  const cell = findDisclosure(frame.transcript);
  return {
    kinds: dumpKinds(frame.transcript),
    collapsed: cell?.collapsed ?? null,
    gutter: cell?.gutter ?? null,
    role: cell?.role ?? null,
    annotation: frame.composer.annotation,
  };
}

export function pickerOf(node: unknown): {
  selectedKey: string | null;
  scrollOffset: number;
  rows: Array<{
    key?: string;
    name?: string;
    status?: string;
    annotation?: string;
    description?: string;
    actionDisplayName?: string;
    href?: string;
    actions?: Array<{ name?: string; displayName?: string; hotkey?: string }>;
  }>;
} {
  const found = findPicker(node);
  return {
    selectedKey: found?.selectedKey ?? null,
    scrollOffset: found?.scrollOffset ?? 0,
    rows: found?.rows ?? [],
  };
}

function statusItemTexts(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text !== "") out.push(text);
      continue;
    }
    if (typeof item === "object" && item !== null && "text" in item) {
      const text = typeof (item as { text: unknown }).text === "string" ? (item as { text: string }).text.trim() : "";
      if (text !== "") out.push(text);
    }
  }
  return out;
}

export function chromeFrame(node: unknown): {
  draft: string;
  placeholder: string;
  completion: string;
  interactive: boolean;
  statusItems: readonly string[];
  quotaWindows: readonly { remainingPercent: number; resetAt?: number }[];
  annotation: string;
  annotationRole: string;
} {
  const frames: Array<{
    draft?: unknown;
    placeholder?: unknown;
    completion?: unknown;
    omitTop?: unknown;
    interactive?: unknown;
    statusItems?: unknown;
    quotaWindows?: unknown;
    annotation?: unknown;
    annotationRole?: unknown;
  }> = [];
  walkChrome(node, frames);
  const stacked = frames.find((frame) => frame.omitTop === true);
  const frame = stacked ?? frames[0];
  return {
    draft: typeof frame?.draft === "string" ? frame.draft : "",
    placeholder: typeof frame?.placeholder === "string" ? frame.placeholder : "",
    completion: typeof frame?.completion === "string" ? frame.completion : "",
    interactive: frame?.interactive !== false,
    statusItems: statusItemTexts(frame?.statusItems),
    quotaWindows: quotaWindowsOf(frame?.quotaWindows),
    annotation: typeof frame?.annotation === "string" ? frame.annotation : "",
    annotationRole: typeof frame?.annotationRole === "string" ? frame.annotationRole : "",
  };
}

function quotaWindowsOf(value: unknown): readonly { remainingPercent: number; resetAt?: number }[] {
  if (!Array.isArray(value)) return [];
  const out: Array<{ remainingPercent: number; resetAt?: number }> = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const remainingPercent = (row as { remainingPercent?: unknown }).remainingPercent;
    if (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent)) continue;
    const resetAt = (row as { resetAt?: unknown }).resetAt;
    out.push(
      typeof resetAt === "number" && Number.isFinite(resetAt) ? { remainingPercent, resetAt } : { remainingPercent },
    );
  }
  return out;
}

function dumpTranscript(node: unknown): TranscriptBlock[] {
  if (typeof node !== "object" || node === null) return [];
  const children = (node as { children?: unknown }).children;
  if (!Array.isArray(children)) return [];
  return children.map((child) => dumpBlock(child, { nested: false }));
}

function dumpBlock(node: unknown, opts: { band?: "input" | "work"; key?: string; nested: boolean }): TranscriptBlock {
  const rec = asRecord(node);
  const key = typeof rec.key === "string" ? rec.key : opts.key;
  const summary = rec.summary;
  const summaryRec = asRecord(summary);
  const block: TranscriptBlock = {
    band: opts.nested ? undefined : (opts.band ?? bandOf(key)),
    type: typeof rec.type === "string" ? rec.type : undefined,
    key,
    role: styleRole(rec.style) ?? styleRole(summaryRec.style),
    gutter: dumpGutter(rec.gutter) ?? dumpGutter(summaryRec.gutter),
    collapsed: typeof rec.collapsed === "boolean" ? rec.collapsed : undefined,
    texts: collectNodeTexts(node),
  };
  if ((rec.type === "box" || rec.type === "disclosure") && Array.isArray(rec.children) && rec.children.length > 0) {
    block.children = rec.children.map((child) => dumpBlock(child, { nested: true }));
  }
  return omitUndefined(block);
}

function dumpComposer(node: unknown): ComposerDump {
  const frame = chromeFrame(node);
  const picker = pickerOf(node);
  return {
    draft: frame.draft,
    completion: frame.completion,
    placeholder: frame.placeholder,
    annotation: frame.annotation,
    annotationRole: frame.annotationRole,
    statusItems: frame.statusItems,
    quotaWindows: frame.quotaWindows,
    interactive: frame.interactive,
    hints: topHints(node),
    glyphs: glyphs(node),
    texts: collectNodeTexts(node),
    picker: {
      selectedKey: picker.selectedKey,
      scrollOffset: picker.scrollOffset,
      rows: picker.rows.map(dumpPickerRow),
    },
  };
}

function dumpPickerRow(row: {
  key?: string;
  name?: string;
  status?: string;
  annotation?: string;
  description?: string;
  actionDisplayName?: string;
  href?: string;
  actions?: Array<{ name?: string; displayName?: string; hotkey?: string }>;
}): PickerRowDump {
  const next: PickerRowDump = {};
  if (row.key) next.key = row.key;
  if (row.name) next.name = row.name;
  if (row.status) next.status = row.status;
  if (row.annotation) next.annotation = row.annotation;
  if (row.description) next.description = row.description;
  if (row.actionDisplayName) next.actionDisplayName = row.actionDisplayName;
  if (row.href) next.href = row.href;
  if (row.actions && row.actions.length > 0) {
    next.actions = row.actions.map((action) => {
      const leaf: { name?: string; displayName?: string; hotkey?: string } = {};
      if (action.name) leaf.name = action.name;
      if (action.displayName) leaf.displayName = action.displayName;
      if (action.hotkey) leaf.hotkey = action.hotkey;
      return leaf;
    });
  }
  return next;
}

export function collectNodeTexts(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  const record = node as {
    type?: unknown;
    content?: unknown;
    children?: unknown;
    summary?: unknown;
    bodySegRows?: unknown;
    placeholder?: unknown;
    annotation?: unknown;
    draft?: unknown;
  };
  const out: string[] = [];
  if (
    (record.type === "text" || record.type === "markdown") &&
    typeof record.content === "string" &&
    record.content.trim() !== ""
  ) {
    out.push(record.content);
  }
  if (record.summary !== undefined) out.push(...collectNodeTexts(record.summary));
  if (typeof record.placeholder === "string" && record.placeholder.trim() !== "") {
    out.push(record.placeholder);
  }
  if (typeof record.annotation === "string" && record.annotation.trim() !== "") {
    out.push(record.annotation);
  }
  if (typeof record.draft === "string" && record.draft.trim() !== "") out.push(record.draft);
  if (Array.isArray(record.bodySegRows)) {
    for (const row of record.bodySegRows) {
      if (!Array.isArray(row)) continue;
      const line = row
        .map((seg) => (typeof (seg as { text?: unknown }).text === "string" ? (seg as { text: string }).text : ""))
        .join("")
        .trim();
      if (line !== "") out.push(line);
    }
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) out.push(...collectNodeTexts(child));
  }
  return out;
}

function dumpGutter(gutter: unknown): unknown {
  if (typeof gutter !== "object" || gutter === null) return undefined;
  const rec = gutter as { kind?: unknown; profile?: unknown; rows?: unknown; glyph?: unknown };
  if (rec.kind === "spinner") {
    return {
      kind: "spinner",
      profile: typeof rec.profile === "string" ? rec.profile : "working",
      ...(rec.rows === "top" || rec.rows === "all" ? { rows: rec.rows } : {}),
    };
  }
  if (rec.kind === "top" && typeof rec.glyph === "string") {
    return { kind: "top", glyph: rec.glyph };
  }
  if (typeof rec.kind === "string") return { kind: rec.kind, glyph: rec.glyph };
  return undefined;
}

function bandOf(key: string | undefined): "input" | "work" | "gap" | undefined {
  if (key === undefined) return undefined;
  if (key.startsWith("gap:")) return "gap";
  if (key.includes("speech-user") || /(?:^|[:-])user(?:$|:)/.test(key)) return "input";
  return "work";
}

function styleRole(style: unknown): string | undefined {
  if (typeof style !== "object" || style === null) return undefined;
  const role = (style as { role?: unknown }).role;
  return typeof role === "string" && role !== "" ? role : undefined;
}

function findPicker(node: unknown):
  | {
      selectedKey?: string | null;
      scrollOffset?: number;
      rows?: PickerRowDump[];
    }
  | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as {
    picker?: {
      selectedKey?: string | null;
      scrollOffset?: number;
      rows?: PickerRowDump[];
    };
    children?: unknown;
  };
  if (record.picker !== undefined) return record.picker;
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      const hit = findPicker(child);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function glyphs(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  const record = node as { bodyGlyphs?: unknown; children?: unknown };
  if (Array.isArray(record.bodyGlyphs) && record.bodyGlyphs.every((g) => typeof g === "string")) {
    return record.bodyGlyphs as string[];
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      const found = glyphs(child);
      if (found.length > 0) return found;
    }
  }
  return [];
}

export function hotkeyLabels(hotkeys: readonly { key: string; action: string }[]): string[] {
  const out: string[] = [];
  for (const hotkey of hotkeys) {
    const label = formatDumpHotkey(hotkey);
    if (label.length > 0) out.push(label);
  }
  return out;
}

function formatDumpHotkey(hotkey: { key: string; action: string }): string {
  const key = hotkey.key.trim();
  const action = hotkey.action.trim();
  if (key.length === 0) return "";
  return action.length > 0 ? `${key}: ${action}` : key;
}

function topHints(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  const record = node as { hotkeys?: unknown; children?: unknown };
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const rec = value as { hotkeys?: unknown; children?: unknown };
    if (Array.isArray(rec.hotkeys)) {
      for (const item of rec.hotkeys) {
        if (typeof item !== "object" || item === null) continue;
        const hotkey = item as { key?: unknown; action?: unknown };
        if (typeof hotkey.key !== "string") continue;
        const label = formatDumpHotkey({
          key: hotkey.key,
          action: typeof hotkey.action === "string" ? hotkey.action : "",
        });
        if (label.length === 0 || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
      }
    }
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) walk(child);
    }
  };
  walk(record);
  return out;
}

function walkChrome(
  node: unknown,
  frames: Array<{
    draft?: unknown;
    placeholder?: unknown;
    completion?: unknown;
    omitTop?: unknown;
    interactive?: unknown;
    statusItems?: unknown;
    quotaWindows?: unknown;
    annotation?: unknown;
    annotationRole?: unknown;
  }>,
): void {
  if (typeof node !== "object" || node === null) return;
  const record = node as {
    type?: unknown;
    draft?: unknown;
    placeholder?: unknown;
    completion?: unknown;
    omitTop?: unknown;
    interactive?: unknown;
    statusItems?: unknown;
    quotaWindows?: unknown;
    annotation?: unknown;
    annotationRole?: unknown;
    children?: unknown;
  };
  if (record.type === "chrome_frame") frames.push(record);
  if (Array.isArray(record.children)) {
    for (const child of record.children) walkChrome(child, frames);
  }
}

function asRecord(node: unknown): Record<string, unknown> {
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>) : {};
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const next = { ...value };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}
