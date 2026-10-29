import { expect, test } from "vitest";

import { createBuffer } from "../../buffer/index.js";
import { layout, measureNode, paintFrame, INDICATION_VOID_GLYPH, type LayoutNode } from "../../layout/index.js";
import { BgP, FgP } from "../../lexicon/index.js";
import { displayWidth } from "../../measure/index.js";
import { expandWidgetPriors } from "../expand.js";
import { Markdown } from "../markdown.js";
import {
  formatClock12h,
  SIGIL_USER,
  Speech,
  SPEECH_STAMP_CELLS,
  SPEECH_STAMP_RESERVE,
  speechBodyWidth,
} from "../speech.js";
import { stampStreamBirth } from "../stream-birth.js";
import { completionSlots, composeWork, hasThoughtRow, transcriptColumn } from "../transcript.js";

function speechBody(node: LayoutNode): unknown {
  const head = "children" in node ? node.children?.[0] : undefined;
  const rail = node.type === "box" && head?.type === "flex" ? head.children?.[1] : head;
  if (rail == null || !("children" in rail)) return undefined;
  const cols = rail.children?.[0];
  if (cols == null || !("children" in cols)) return undefined;
  return cols.children?.[0];
}

function lineChars(buf: ReturnType<typeof createBuffer>, y: number): string {
  let out = "";
  for (let x = 0; x < buf.width; x++) out += buf.cells[y * buf.width + x]?.ch || " ";
  return out;
}

function childKeys(node: LayoutNode | null): Array<string | undefined> {
  return node !== null && "children" in node ? (node.children ?? []).map((child) => child.key) : [];
}

test("Speech user and live assistant pick the product glyphs", () => {
  const voice = { role: "foreground", prominence: FgP.primary };
  const user = Speech({ text: "hi", voice: "user" }, { key: "u" });
  const live = Speech({ text: "ok", live: true }, { key: "a", width: 20 });
  const sealed = Speech({ text: "ok" }, { key: "s", width: 20 });
  const failed = Speech({ text: "turn failed", failed: true }, { key: "f" });
  if (user.type !== "box" || live.type !== "indication" || sealed.type !== "indication") {
    throw new Error("speech");
  }
  const chevron = user.children?.[0]?.type === "flex" ? user.children[0].children?.[0] : undefined;
  expect({
    user: { style: user.style, chevron, body: speechBody(user) },
    live: { gutter: live.gutter, style: live.style, body: speechBody(live) },
    sealed: { gutter: sealed.gutter, style: sealed.style, body: speechBody(sealed) },
    failed: { style: failed.type === "indication" ? failed.style : undefined, body: speechBody(failed) },
  }).toMatchObject({
    user: {
      style: { padding: 1, background: { bgRole: "surface", bgProminence: BgP.mist } },
      chevron: { type: "text", content: SIGIL_USER, style: { ...voice, bold: true } },
      body: { children: [{ type: "markdown", style: voice }] },
    },
    live: {
      gutter: { kind: "top", glyph: INDICATION_VOID_GLYPH },
      style: { role: "foreground", prominence: FgP.rising },
      body: { children: [{ type: "markdown", style: voice }] },
    },
    sealed: {
      gutter: { kind: "top", glyph: INDICATION_VOID_GLYPH },
      style: voice,
      body: { children: [{ type: "markdown", style: voice }] },
    },
    failed: {
      style: { role: "error" },
      body: { children: [{ style: { role: "error" } }] },
    },
  });
});

test("user floor is a surface mist one cell off the prose, chevron inside", () => {
  const railW = 20;
  const w = railW + 4;
  const node = Speech({ text: "hi", voice: "user" }, { key: "u", width: railW });
  const h = measureNode(node, w, 10).h;
  const buf = createBuffer(w, h);
  paintFrame(layout(node, { w, h }), buf);
  const at = (x: number, y: number) => buf.cells[y * w + x]!;
  const pad = at(0, 0);
  const lead = at(0, 1);
  const mark = at(1, 1);
  const gap = at(2, 1);
  const prose = at(3, 1);
  const edge = at(w - 1, 1);
  const below = at(0, h - 1);
  expect({
    h,
    line: lineChars(buf, 1).slice(0, 4),
    floor: pad.style.bgRole,
    step: pad.style.bgProminence,
    leadCh: lead.ch,
    markCh: mark.ch,
    gapCh: gap.ch,
    proseCh: prose.ch,
    edgeCh: edge.ch,
    belowCh: below.ch.trim(),
    leadRole: lead.style.bgRole,
    belowRole: below.style.bgRole,
    edgeRole: edge.style.bgRole,
  }).toEqual({
    h: 3,
    line: ` ${SIGIL_USER} h`,
    floor: "surface",
    step: BgP.mist,
    leadCh: " ",
    markCh: SIGIL_USER,
    gapCh: " ",
    proseCh: "h",
    edgeCh: " ",
    belowCh: "",
    leadRole: "surface",
    belowRole: "surface",
    edgeRole: "surface",
  });
});

test("formatClock12h is H:MM AM/PM without a leading hour zero", () => {
  expect({
    afternoon: formatClock12h(new Date(2023, 10, 14, 15, 4).getTime()),
    midnight: formatClock12h(new Date(2023, 10, 14, 0, 5).getTime()),
    noon: formatClock12h(new Date(2023, 10, 14, 12, 0).getTime()),
    night: formatClock12h(new Date(2023, 10, 14, 23, 59).getTime()),
  }).toEqual({
    afternoon: "3:04 PM",
    midnight: "12:05 AM",
    noon: "12:00 PM",
    night: "11:59 PM",
  });
});

test("Speech reserves 8 stamp cells plus a gap and right-pads the clock", () => {
  const atMs = new Date(2023, 10, 14, 15, 4).getTime();
  const width = 40;
  const node = Speech({ text: "hello from the user", voice: "user", atMs }, { key: "u", width });
  if (node.type !== "box") throw new Error("speech");
  const row = node.children?.[0];
  if (row?.type !== "flex") throw new Error("speech line");
  const rail = row.children?.[1] as {
    style?: { width?: number };
    children?: Array<{
      children?: Array<{ style?: { width?: number }; children?: Array<{ content?: string }> }>;
    }>;
  };
  const cols = rail.children?.[0]?.children ?? [];
  const clock = formatClock12h(atMs);
  expect({
    reserve: SPEECH_STAMP_RESERVE,
    cells: SPEECH_STAMP_CELLS,
    bodyW: speechBodyWidth(width),
    railW: rail.style?.width,
    bodyBox: cols[0]?.style?.width,
    stampBox: cols[1]?.style?.width,
    face: cols[1]?.children?.[0]?.content,
  }).toEqual({
    reserve: 9,
    cells: 8,
    bodyW: 31,
    railW: 40,
    bodyBox: 31,
    stampBox: 8,
    face: ` ${clock}`,
  });
});

test("completionSlots matches the visible tape", () => {
  expect(
    completionSlots({
      live: false,
      failed: true,
      workerPresent: false,
      speech: "partial",
      thought: "",
      failure: "boom",
    }),
  ).toMatchObject({
    showSpeech: true,
    speechText: "partial",
    showFailure: false,
  });
  expect(
    completionSlots({
      live: false,
      failed: true,
      workerPresent: false,
      speech: "",
      thought: "",
      failure: "boom",
    }),
  ).toMatchObject({
    showSpeech: false,
    showFailure: true,
    failureText: "boom",
  });
  expect(
    completionSlots({
      live: true,
      failed: false,
      workerPresent: true,
      homed: true,
      speech: "",
      thought: "",
      failure: "",
    }),
  ).toMatchObject({
    emptyLiveThought: true,
    bootstrapping: false,
  });
  expect(
    completionSlots({
      live: true,
      failed: false,
      workerPresent: false,
      homed: true,
      speech: "",
      thought: "",
      failure: "",
    }),
  ).toMatchObject({
    emptyLiveThought: false,
    bootstrapping: true,
  });
  expect(
    hasThoughtRow(
      completionSlots({
        live: true,
        failed: false,
        workerPresent: true,
        speech: "",
        thought: "",
        failure: "",
      }),
    ),
  ).toBe(false);
});

function stickyOf(node: LayoutNode | undefined): string | undefined {
  return node?.type === "box" ? node.style?.sticky : undefined;
}

test("transcriptColumn sticks every user box and leaves recap alone", () => {
  const first = { type: "box" as const, key: "u1", children: [] as LayoutNode[] };
  const second = { type: "box" as const, key: "u2", children: [] as LayoutNode[] };
  const recap = { type: "text" as const, key: "recap", content: "recap" };
  const stuck = transcriptColumn(
    [
      { band: "input", key: "u1", node: first },
      { band: "work", key: "w", node: { type: "box", key: "w", children: [] } },
      { band: "input", key: "u2", node: second },
      { band: "work", key: "w2", node: { type: "text", key: "x", content: "x" } },
    ],
    20,
  );
  const older = transcriptColumn(
    [
      { band: "input", key: "u1", node: first },
      { band: "input", key: "recap", node: recap },
    ],
    20,
  );
  const find = (root: LayoutNode, key: string): LayoutNode | undefined =>
    "children" in root ? root.children?.find((child) => child.key === key) : undefined;
  expect({
    firstStuck: "style" in first,
    u1: stickyOf(find(stuck, "u1")),
    u2: stickyOf(find(stuck, "u2")),
    older: stickyOf(find(older, "u1")),
    recap: stickyOf(find(older, "recap")),
  }).toEqual({
    firstStuck: false,
    u1: "top",
    u2: "top",
    older: "top",
    recap: undefined,
  });
});

test("transcriptColumn inserts one spacer when the band changes", () => {
  const root = transcriptColumn(
    [
      { band: "input", key: "u", node: { type: "box", key: "u", children: [] } },
      { band: "work", key: "w", node: { type: "box", key: "w", children: [] } },
    ],
    40,
  );
  expect(childKeys(root)).toEqual(["u", "gap:input-work:w", "w"]);
});

test("transcriptColumn gives thinking a 1-cell margin above and below", () => {
  const empty = { type: "box" as const, children: [] };
  const keys = (parts: Parameters<typeof transcriptColumn>[0]) => childKeys(transcriptColumn(parts, 40));
  expect({
    first: keys([{ band: "work", slot: "thought", key: "t", node: { ...empty, key: "t" } }]),
    between: keys([
      { band: "work", key: "a", node: { ...empty, key: "a" } },
      { band: "work", slot: "thought", key: "t", node: { ...empty, key: "t" } },
      { band: "work", key: "b", node: { ...empty, key: "b" } },
    ]),
    thoughtSpeech: keys([
      { band: "work", slot: "thought", key: "t", node: { ...empty, key: "t" } },
      { band: "work", slot: "speech", key: "s", node: { ...empty, key: "s" } },
    ]),
    userThenThought: keys([
      { band: "input", key: "u", node: { ...empty, key: "u" } },
      { band: "work", slot: "thought", key: "t", node: { ...empty, key: "t" } },
    ]),
  }).toEqual({
    first: ["t", "gap:thought-after:t"],
    between: ["a", "gap:thought-before:t", "t", "gap:thought-after:t", "b"],
    thoughtSpeech: ["t", "gap:thought-after:t", "s"],
    userThenThought: ["u", "gap:input-work:t", "t", "gap:thought-after:t"],
  });
});

test("transcriptColumn fuses consecutive tools and margins the cluster", () => {
  const empty = { type: "box" as const, children: [] };
  const keys = (parts: Parameters<typeof transcriptColumn>[0]) => childKeys(transcriptColumn(parts, 40));
  expect({
    fusedThenSpeech: keys([
      { band: "work", slot: "tool", key: "r", node: { ...empty, key: "r" } },
      { band: "work", slot: "tool", key: "w", node: { ...empty, key: "w" } },
      { band: "work", slot: "speech", key: "s", node: { ...empty, key: "s" } },
    ]),
    thoughtToolsSpeech: keys([
      { band: "work", slot: "thought", key: "t", node: { ...empty, key: "t" } },
      { band: "work", slot: "tool", key: "r", node: { ...empty, key: "r" } },
      { band: "work", slot: "tool", key: "w", node: { ...empty, key: "w" } },
      { band: "work", slot: "speech", key: "s", node: { ...empty, key: "s" } },
    ]),
    toolsThenThought: keys([
      { band: "work", slot: "tool", key: "r", node: { ...empty, key: "r" } },
      { band: "work", slot: "thought", key: "t", node: { ...empty, key: "t" } },
      { band: "work", slot: "speech", key: "s", node: { ...empty, key: "s" } },
    ]),
  }).toEqual({
    fusedThenSpeech: ["r", "w", "gap:tools-after:w", "s"],
    thoughtToolsSpeech: ["t", "r", "w", "gap:tools-after:w", "s"],
    toolsThenThought: ["r", "t", "gap:thought-after:t", "s"],
  });
});

test("composeWork stacks thought, gap, speech", () => {
  const node = composeWork(
    "work",
    20,
    { type: "box", key: "t", children: [] },
    { type: "box", key: "s", children: [] },
  );
  expect(childKeys(node)).toEqual(["t", "work:thought-gap", "s"]);
});

test("stampStreamBirth crawls the newest markdown line", () => {
  const newest = "second line of the reply";
  const md = expandWidgetPriors(Markdown(`first line of the reply\n\n${newest}`, { key: "md" }), { width: 40 });
  const stamped = stampStreamBirth(md, { siteId: "speech", width: 40 });
  expect({
    birth: findLiveBirth(stamped),
    newest: liveBirthContents(stamped).some((t) => t.includes("second")),
    older: liveBirthContents(stamped).some((t) => t.includes("first")),
  }).toEqual({
    birth: { kind: "birth", offset: 0, T: displayWidth(newest), siteId: "speech" },
    newest: true,
    older: false,
  });
});

function findLiveBirth(node: unknown): { kind: string; T: number; offset: number; siteId: string } | null {
  if (!node || typeof node !== "object") return null;
  const n = node as {
    live?: { kind?: string; T?: number; offset?: number; siteId?: string };
    children?: unknown[];
  };
  if (n.live?.kind === "birth") {
    return {
      kind: "birth",
      T: n.live.T ?? 0,
      offset: n.live.offset ?? 0,
      siteId: n.live.siteId ?? "",
    };
  }
  for (const c of n.children ?? []) {
    const hit = findLiveBirth(c);
    if (hit) return hit;
  }
  return null;
}

function liveBirthContents(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as {
    live?: { kind?: string };
    content?: string;
    children?: unknown[];
  };
  const out: string[] = [];
  if (n.live?.kind === "birth" && typeof n.content === "string") out.push(n.content);
  for (const c of n.children ?? []) out.push(...liveBirthContents(c));
  return out;
}
