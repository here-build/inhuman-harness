import { createPaintLocal, writePaintEcho } from "@inhuman.tools/quickdraw/runtime";
import { expect, test } from "vitest";

import {
  createComposer,
  createPaintRoot,
  createRewind,
  createSpeech,
  createTurn,
  createWorkCell,
} from "../paint-dom.js";
import { createHarnessPaintSource, scrollToShowBlock, tapeViewportRows } from "../paint-source.js";
import { createPaintReader, createPaintWriter, type PaintDownMessage } from "../paint-transport.js";

function walkKeys(node: unknown, keys: string[] = []): string[] {
  if (typeof node !== "object" || node === null) return keys;
  const rec = node as { key?: string; children?: unknown[] };
  if (typeof rec.key === "string") keys.push(rec.key);
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) walkKeys(child, keys);
  }
  return keys;
}

async function flush(): Promise<void> {
  await Promise.resolve();
}

function disclosuresOf(node: unknown): Array<{ collapsed: boolean | undefined; blockId: string | undefined }> {
  const out: Array<{ collapsed: boolean | undefined; blockId: string | undefined }> = [];
  const walk = (cur: unknown): void => {
    if (typeof cur !== "object" || cur === null) return;
    const rec = cur as {
      type?: unknown;
      collapsed?: unknown;
      onClick?: { type?: unknown; blockId?: unknown };
      summary?: unknown;
      children?: unknown;
    };
    if (rec.type === "disclosure") {
      out.push({
        collapsed: typeof rec.collapsed === "boolean" ? rec.collapsed : undefined,
        blockId:
          rec.onClick?.type === "toggle_collapsed" && typeof rec.onClick.blockId === "string"
            ? rec.onClick.blockId
            : undefined,
      });
    }
    if (rec.summary !== undefined) walk(rec.summary);
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) walk(child);
    }
  };
  walk(node);
  return out;
}

test("prepare() assembles the product column from the replica", async () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  const tape = createTurn();
  const composer = createComposer();
  root.appendChild(tape);
  root.appendChild(composer);
  composer.setDraft("hello");
  composer.setCursor(5);
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);

  const live = createHarnessPaintSource({ reader });
  const local = createPaintLocal(40, 12);
  let paints = 0;
  live.bind(
    {
      requestPaint: () => {
        paints += 1;
      },
    },
    local,
  );
  const prepared = live.prepare();
  expect({
    composer: prepared.composer,
    rootType: prepared.root?.type,
    paintReady: prepared.root?.paintReady,
    keys: walkKeys(prepared.root),
  }).toEqual({
    composer: {
      draft: "hello",
      cursor: 5,
      mark: null,
      interactive: true,
    },
    rootType: "box",
    paintReady: undefined,
    keys: expect.arrayContaining([
      "frame",
      "root",
      "transcript:frame",
      "transcript:viewport",
      "rim",
      "composer:frame",
      "statusline",
    ]),
  });

  const first = live.prepare();
  const same = live.prepare();
  composer.setDraft("hello!");
  await flush();
  reader.apply(posted[posted.length - 1]!);
  live.noteReplica("paint_patch");
  const after = live.prepare();
  expect({
    paints: paints > 0,
    draft: after.composer.draft,
    sameObject: first === same,
    changed: first !== after,
  }).toEqual({
    paints: true,
    draft: "hello!",
    sameObject: true,
    changed: true,
  });

  writer.dispose();
  reader.dispose();
});

test("bind after patches requests one paint", () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  root.appendChild(createComposer());
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);
  const source = createHarnessPaintSource({ reader });
  source.noteReplica("paint_init");
  let paints = 0;
  source.bind(
    {
      requestPaint: () => {
        paints += 1;
      },
    },
    createPaintLocal(),
  );
  expect(paints).toBe(1);
  writer.dispose();
  reader.dispose();
});

test("echo reconcile clears on matching replica or focus loss; status does not", async () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  const composer = createComposer();
  root.appendChild(composer);
  composer.setDraft("ab");
  composer.setCursor(2);
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);
  const source = createHarnessPaintSource({ reader });
  const local = createPaintLocal();
  writePaintEcho(local, { predicted: { draft: "abc", cursor: 3, mark: null }, misaligned: false });
  source.bind({ requestPaint: () => undefined }, local);

  composer.setStatusItems(["gpt"]);
  await flush();
  reader.apply(posted[posted.length - 1]!);
  const afterStatus = local.echo.predicted;

  composer.setDraft("abc");
  composer.setCursor(3);
  await flush();
  reader.apply(posted[posted.length - 1]!);
  const afterMatch = { predicted: local.echo.predicted, misaligned: local.echo.misaligned };

  writePaintEcho(local, { predicted: { draft: "typed after focus moved", cursor: 23, mark: null }, misaligned: false });
  composer.setInteractive(false);
  await flush();
  reader.apply(posted[posted.length - 1]!);
  expect({
    afterStatus,
    afterMatch,
    afterBlur: {
      predicted: local.echo.predicted,
      misaligned: local.echo.misaligned,
      interactive: source.prepare().composer.interactive,
    },
  }).toEqual({
    afterStatus: { draft: "abc", cursor: 3, mark: null },
    afterMatch: { predicted: null, misaligned: false },
    afterBlur: { predicted: null, misaligned: false, interactive: false },
  });

  writer.dispose();
  reader.dispose();
});

test("toggleCollapsed flips disclosure collapsed across prepare()", () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  const tape = createTurn();
  const cell = createWorkCell("tool");
  cell.setFace({
    name: "grep",
    object: "src/tea.ts",
    status: "",
    state: "ok",
    indent: false,
    split: false,
    receiptKind: "text",
    receiptText: "export function openTea() {}",
    diffOld: "",
    diffNew: "",
    diffPath: "",
  });
  tape.appendChild(cell);
  root.appendChild(tape);
  root.appendChild(createComposer());
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);

  const source = createHarnessPaintSource({ reader });
  source.toggleCollapsed("paint:1");
  const local = createPaintLocal(40, 12);
  local.tapeExpanded = true;
  source.bind({ requestPaint: () => undefined }, local);
  const first = disclosuresOf(source.prepare().root);
  const blockId = first[0]?.blockId;
  source.toggleCollapsed(blockId!);
  const second = disclosuresOf(source.prepare().root);
  expect({
    first: { n: first.length > 0, collapsed: first[0]?.collapsed, blockId: typeof blockId },
    second: second[0]?.collapsed,
  }).toEqual({
    first: { n: true, collapsed: true, blockId: "string" },
    second: false,
  });

  writer.dispose();
  reader.dispose();
});

test("prepare() seats an ask pin between tape and rim", () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  const tape = createTurn();
  const ask = createWorkCell("ask");
  ask.setFace({
    name: "edit_file",
    object: "a.ts",
    status: "ask",
    state: "ask",
    indent: false,
    split: false,
    receiptKind: "diff",
    receiptText: "",
    diffOld: "a",
    diffNew: "b",
    diffPath: "a.ts",
  });
  const composer = createComposer();
  root.appendChild(tape);
  root.appendChild(ask);
  root.appendChild(composer);
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);

  const live = createHarnessPaintSource({ reader });
  live.bind({ requestPaint: () => undefined }, createPaintLocal(40, 12));
  const keys = walkKeys(live.prepare().root);
  expect({
    order: [keys.indexOf("transcript:viewport"), keys.indexOf("ask:diff"), keys.indexOf("rim")],
    pin: keys.includes("ask:pin"),
  }).toEqual({
    order: [expect.any(Number), expect.any(Number), expect.any(Number)],
    pin: false,
  });
  expect(keys.indexOf("transcript:viewport")).toBeLessThan(keys.indexOf("ask:diff"));
  expect(keys.indexOf("ask:diff")).toBeLessThan(keys.indexOf("rim"));

  writer.dispose();
  reader.dispose();
});

test("prepare() pin arbitration: wait above rim; ask owns the slot", () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  const tape = createTurn();
  const wait = createWorkCell("wait");
  wait.setFace({
    name: "waiting",
    object: "",
    status: "",
    state: "live",
    indent: false,
    receiptKind: "none",
    receiptText: "",
    diffOld: "",
    diffNew: "",
    diffPath: "",
    startedAt: 0,
  });
  const composer = createComposer();
  root.appendChild(tape);
  root.appendChild(wait);
  root.appendChild(composer);
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);

  const live = createHarnessPaintSource({ reader });
  live.bind({ requestPaint: () => undefined }, createPaintLocal(40, 12));
  const waitKeys = walkKeys(live.prepare().root);
  writer.dispose();
  reader.dispose();

  const postedAsk: PaintDownMessage[] = [];
  const writerAsk = createPaintWriter("e1", (message) => postedAsk.push(message));
  const rootAsk = createPaintRoot();
  const tapeAsk = createTurn();
  const askCell = createWorkCell("ask");
  askCell.setFace({
    name: "read_file",
    object: "a.ts",
    status: "ask",
    state: "ask",
    indent: false,
    receiptKind: "none",
    receiptText: "",
    diffOld: "",
    diffNew: "",
    diffPath: "",
  });
  const waitAsk = createWorkCell("wait");
  waitAsk.setFace({
    name: "waiting",
    object: "",
    status: "",
    state: "live",
    indent: false,
    receiptKind: "none",
    receiptText: "",
    diffOld: "",
    diffNew: "",
    diffPath: "",
    startedAt: 0,
  });
  rootAsk.appendChild(tapeAsk);
  rootAsk.appendChild(askCell);
  rootAsk.appendChild(waitAsk);
  rootAsk.appendChild(createComposer());
  writerAsk.attach(rootAsk);
  const readerAsk = createPaintReader();
  readerAsk.apply(postedAsk[0]!);
  const liveAsk = createHarnessPaintSource({ reader: readerAsk });
  liveAsk.bind({ requestPaint: () => undefined }, createPaintLocal(40, 12));
  const askKeys = walkKeys(liveAsk.prepare().root);

  expect({
    wait: {
      pin: waitKeys.includes("wait:pin"),
      ask: waitKeys.includes("ask:pin"),
      beforeRim:
        waitKeys.indexOf("transcript:viewport") < waitKeys.indexOf("wait:pin") &&
        waitKeys.indexOf("wait:pin") < waitKeys.indexOf("rim"),
    },
    askOwns: {
      ask: askKeys.includes("ask:pin"),
      wait: askKeys.includes("wait:pin"),
    },
  }).toEqual({
    wait: { pin: true, ask: false, beforeRim: true },
    askOwns: { ask: true, wait: false },
  });

  writerAsk.dispose();
  readerAsk.dispose();
});

test("prepare() off-tip seats neighbors on one tape and hides the rim", async () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  const tape = createTurn();
  tape.appendChild(createSpeech("pin", "user"));
  const composer = createComposer();
  composer.setReadOnly(true);
  const rewind = createRewind();
  rewind.setFace(false, [{ key: "past-1", text: "older" }], [{ key: "next-1", text: "newer" }]);
  root.appendChild(tape);
  root.appendChild(composer);
  root.appendChild(rewind);
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);

  const live = createHarnessPaintSource({ reader });
  live.bind({ requestPaint: () => undefined }, createPaintLocal(80, 24));
  const keys = walkKeys(live.prepare().root);
  expect({
    behind: keys.includes("rewind:behind"),
    ahead: keys.includes("rewind:ahead"),
    tape: keys.includes("transcript:viewport"),
    rim: keys.includes("rim"),
    future: keys.includes("transcript-future:viewport"),
  }).toEqual({
    behind: true,
    ahead: true,
    tape: true,
    rim: false,
    future: false,
  });
  expect(keys.indexOf("rewind:behind")).toBeLessThan(keys.indexOf("transcript:viewport"));
  expect(keys.indexOf("transcript:viewport")).toBeLessThan(keys.indexOf("rewind:ahead"));

  writer.dispose();
  reader.dispose();
});

test("history navigation scrolls the active message onto the viewport floor", () => {
  expect(scrollToShowBlock(0, 3, 10)).toBe(0);
  expect(scrollToShowBlock(20, 4, 10)).toBe(17);
  expect(scrollToShowBlock(20, 30, 10)).toBe(20);
  expect(scrollToShowBlock(5, 1, 5)).toBe(3);
  expect(tapeViewportRows(24, { composerH: 0, pinH: 0, pastH: 3, futureH: 3 })).toBe(14);

  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  const tape = createTurn();
  tape.appendChild(createSpeech("older prompt that sits above", "user"));
  const activeSpeech = createSpeech("the active prompt", "user");
  activeSpeech.setRecap(true, "title");
  tape.appendChild(activeSpeech);
  const composer = createComposer();
  const rewind = createRewind();
  rewind.setFace(false, [{ key: "past-1", text: "older" }], [{ key: "next-1", text: "newer" }]);
  root.appendChild(tape);
  root.appendChild(composer);
  root.appendChild(rewind);
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);

  const live = createHarnessPaintSource({ reader });
  const local = createPaintLocal(80, 24);
  live.bind({ requestPaint: () => undefined }, local);
  const speeches = walkSpeeches(live.prepare().root);
  const active = speeches.find((speech) => speech.key.endsWith(":recap"));
  expect(active).toBeDefined();
  expect(local.tapeAtBottom).toBe(false);
  const viewport = tapeViewportRows(24, { composerH: 0, pinH: 0, pastH: 3, futureH: 3 });
  expect(local.tapeScroll).toBe(scrollToShowBlock(active!.y, active!.h, viewport));
  expect(local.tapeScroll).not.toBe(active!.y);

  writer.dispose();
  reader.dispose();
});

function walkSpeeches(node: unknown, y = { n: 0 }, out: { key: string; y: number; h: number }[] = []) {
  if (typeof node !== "object" || node === null) return out;
  const rec = node as {
    key?: string;
    type?: string;
    measured?: { h?: number };
    style?: { height?: number };
    children?: unknown[];
  };
  if (rec.key === "transcript:body" && Array.isArray(rec.children)) {
    let row = 0;
    for (const child of rec.children) {
      const item = child as { key?: string; measured?: { h?: number }; style?: { height?: number } };
      const h = item.measured?.h ?? item.style?.height ?? 0;
      if (typeof item.key === "string") out.push({ key: item.key, y: row, h });
      row += h;
    }
    return out;
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) walkSpeeches(child, y, out);
  }
  return out;
}

test("prepare() reports picker rows from the composer widget", () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const root = createPaintRoot();
  const composer = createComposer();
  root.appendChild(composer);
  composer.setCommandChoices([{ key: "c1", name: "/connect", actions: [] }]);
  writer.attach(root);
  const reader = createPaintReader();
  reader.apply(posted[0]!);
  const source = createHarnessPaintSource({ reader });
  source.bind({ requestPaint: () => undefined }, createPaintLocal(40, 12));
  const prepared = source.prepare();
  expect({
    root: prepared.root !== null,
    picker: { n: prepared.picker?.n, keys: prepared.picker?.paintRowToKey },
  }).toEqual({
    root: true,
    picker: { n: 1, keys: expect.arrayContaining(["c1"]) },
  });
  writer.dispose();
  reader.dispose();
});
