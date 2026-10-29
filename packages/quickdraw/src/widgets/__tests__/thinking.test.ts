import { expect, test } from "vitest";

import { type LayoutNode } from "../../layout/index.js";
import { FgP } from "../../lexicon/index.js";
import { displayWidth } from "../../measure/index.js";
import { ThinkingStream, wrapThoughtLines, type ThinkingModel } from "../index.js";
import { ShadowStream } from "../shadow-stream.js";

test("ThinkingStream state walk", () => {
  const omitted = (durationMs?: number) =>
    bodyText(ThinkingStream({ text: "", live: false, seal: "sealed", durationMs, agentLabel: "Claude" }, { key: "t" }));
  expect({
    copy: omitted(),
    timed: omitted(3400),
  }).toEqual({
    copy: "Claude did not share the thinking",
    timed: "Claude did not share the thinking · 3.4s",
  });

  const collapsed = ThinkingStream(
    {
      text: "secret reasoning about the plan",
      live: false,
      collapsed: true,
      seal: "sealed",
      durationMs: 5000,
    },
    { key: "r1", width: 51 },
  );
  const collapsedVisible = collectText(visible(collapsed)).replaceAll(/\s+/g, "");
  const summarized = ThinkingStream(
    {
      text: "**Assessing the repo**\n\n**looking for answers**",
      live: false,
      collapsed: true,
      seal: "sealed",
      durationMs: 5000,
      thoughtKind: "summary",
    },
    { key: "r-sum", width: 51 },
  );
  const summarizedVisible = collectText(visible(summarized)).replaceAll(/\s+/g, "");
  const summarizing = ThinkingStream(
    {
      text: "plan",
      live: true,
      collapsed: true,
      seal: "live",
      durationMs: 1200,
      thoughtKind: "summary",
    },
    { key: "r-sum-live", width: 40 },
  );
  const summarizingFlat = collectText(visible(summarizing)).replaceAll(/\s+/g, "");
  expect({
    type: collapsed.type,
    collapsed: collapsed.type === "disclosure" ? collapsed.collapsed : undefined,
    intent: collapsed.type === "disclosure" ? collapsed.intent : undefined,
    onClick: collapsed.type === "disclosure" ? collapsed.onClick : undefined,
    gutter: gutterOf(collapsed)?.kind,
    duration: collapsedVisible.includes("thoughtfor5s"),
    tail: collapsedVisible.includes("secretreasoningabouttheplan"),
    hidden: collectText(collapsed).includes("secret reasoning"),
    summaryLine: summarizedVisible.includes("lookingforanswersfor5s"),
    summaryNotGeneric: summarizedVisible.includes("summaryfor") || summarizedVisible.includes("thoughtfor"),
    liveHeading: summarizingFlat.includes("planfor1.2s"),
    liveNotSummarizing: summarizingFlat.includes("summarizing"),
  }).toEqual({
    type: "disclosure",
    collapsed: true,
    intent: "activate",
    onClick: { type: "toggle_collapsed", blockId: "r1" },
    gutter: "top",
    duration: true,
    tail: true,
    hidden: true,
    summaryLine: true,
    summaryNotGeneric: false,
    liveHeading: true,
    liveNotSummarizing: false,
  });

  const empty = ThinkingStream(
    {
      text: "",
      live: false,
      collapsed: true,
      seal: "sealed",
      durationMs: 3200,
      agentLabel: "Claude",
    },
    { key: "r-empty" },
  );
  expect({
    type: empty.type,
    intent: empty.type === "indication" ? empty.intent : undefined,
    gutter: gutterOf(empty)?.kind,
    copy: bodyText(empty),
  }).toEqual({
    type: "indication",
    intent: "none",
    gutter: "top",
    copy: "Claude did not share the thinking · 3.2s",
  });

  const waiting = ThinkingStream(
    {
      text: "",
      live: true,
      seal: "live",
      startedAt: 0,
      occupancyLabel: "waiting for response...",
    },
    { key: "r-wait" },
  );
  const handshake = ThinkingStream(
    {
      text: "",
      live: true,
      seal: "live",
      bootstrapping: true,
    },
    { key: "r-boot" },
  );
  expect({
    gutter: gutterOf(waiting),
    copy: collectText(waiting).includes("waiting for response..."),
    live: findElapsed(waiting),
    handshake: {
      copy: collectText(handshake).includes("connecting..."),
      tools: collectText(handshake).includes("using tools..."),
      waiting: collectText(handshake).includes("waiting for response..."),
      live: findElapsed(handshake),
    },
  }).toEqual({
    gutter: { kind: "spinner", profile: "thinking", rows: "top" },
    copy: true,
    live: { kind: "elapsed", startedAt: 0, label: "waiting for response...", hz: 2 },
    handshake: { copy: true, tools: false, waiting: false, live: null },
  });

  const retrying = ThinkingStream(
    {
      text: "",
      live: true,
      seal: "live",
      startedAt: 0,
      retryUntilMs: 5_000,
      occupancyLabel: "waiting for response...",
    },
    { key: "r-retry" },
  );
  expect({
    gutter: gutterOf(retrying),
    copy: collectText(retrying).includes("Failed to request"),
    live: findElapsed(retrying),
  }).toEqual({
    gutter: { kind: "spinner", profile: "thinking", rows: "top" },
    copy: true,
    live: { kind: "countdown", untilMs: 5_000, hz: 2 },
  });

  const peek = ThinkingStream(
    {
      text: [
        "first premise line here",
        "second premise continues",
        "third step of the plan",
        "fourth newest stream chunk",
      ].join("\n"),
      live: true,
      collapsed: true,
      seal: "live",
      durationMs: 1200,
      peekLines: 3,
    },
    { key: "r-live", width: 40 },
  );
  const peekFlat = collectText(visible(peek)).replaceAll(/\s+/g, "");
  const peekNewest = newestPeekProminence(visible(peek));
  const birthNode = ThinkingStream(
    {
      text: ["older line still in peek", "settled premise text past the tip window then emerging tip zone"].join("\n"),
      live: true,
      collapsed: true,
      seal: "live",
      durationMs: 800,
      peekLines: 3,
      tipWindow: 12,
      wavefront: true,
    },
    { key: "r-birth", width: 72 },
  );
  const birth = findLiveBirth(visible(birthNode));
  const newestLine = "settled premise text past the tip window then emerging tip zone";
  expect({
    gutter: gutterOf(peek),
    extraGutter: extraGutterOf(peek),
    newest: peekFlat.includes("fourthnewest"),
    oldest: peekFlat.includes("firstpremise"),
    newestProminence: peekNewest,
    intent: peek.type === "disclosure" ? peek.intent : undefined,
    onClick: peek.type === "disclosure" ? peek.onClick : undefined,
    birthOff: findLiveBirth(visible(peek)),
    birth: {
      kind: birth?.kind,
      offset: birth?.offset,
      T: birth?.T,
    },
  }).toEqual({
    gutter: { kind: "top", glyph: "⁖" },
    extraGutter: { kind: "rule", glyph: "┃" },
    newest: true,
    oldest: false,
    newestProminence: FgP.rising,
    intent: "activate",
    onClick: { type: "toggle_collapsed", blockId: "r-live" },
    birthOff: null,
    birth: {
      kind: "birth",
      offset: 0,
      T: displayWidth(newestLine),
    },
  });

  const latestSealed = ThinkingStream(
    {
      text: [
        "first premise line here",
        "second premise continues",
        "third step of the plan",
        "fourth newest stream chunk",
      ].join("\n"),
      live: false,
      collapsed: true,
      latest: true,
      seal: "sealed",
      durationMs: 5000,
    },
    { key: "r-latest", width: 40 },
  );
  const latestFlat = collectText(visible(latestSealed)).replaceAll(/\s+/g, "");
  expect({
    gutter: gutterOf(latestSealed)?.kind,
    extraGutter: extraGutterOf(latestSealed),
    newest: latestFlat.includes("fourthnewest"),
    oldest: latestFlat.includes("firstpremise"),
    birth: findLiveBirth(visible(latestSealed)),
  }).toEqual({
    gutter: "top",
    extraGutter: undefined,
    newest: true,
    oldest: false,
    birth: null,
  });

  const sealedOpen = ThinkingStream(
    {
      text: "weighing **options** quietly",
      live: false,
      collapsed: false,
      seal: "sealed",
      durationMs: 1000,
    },
    { key: "r3" },
  );
  const liveOpen = ThinkingStream(
    { text: "\nweighing options\n\n", live: true, collapsed: false, seal: "live" } satisfies ThinkingModel,
    { key: "r2" },
  );
  const sealedKids = sealedOpen.type === "disclosure" ? (sealedOpen.children ?? []) : [];
  const liveKids = liveOpen.type === "disclosure" ? (liveOpen.children ?? []) : [];
  const sealedHeader = sealedKids[0];
  const sealedBar = sealedKids[1];
  const sealedMd =
    sealedBar?.type === "indication" ? sealedBar.children?.find((c) => c.type === "markdown") : undefined;
  const liveHeaderNode = liveKids[0];
  const liveBar = liveKids[1];
  expect({
    sealed: {
      headerGutter: sealedHeader?.type === "indication" ? sealedHeader.gutter : undefined,
      barGutter: sealedBar?.type === "indication" ? sealedBar.gutter : undefined,
      markdown: sealedMd?.type === "markdown" ? sealedMd.content : undefined,
      role: sealedMd?.type === "markdown" ? sealedMd.style?.role : undefined,
      prominence: sealedMd?.type === "markdown" ? sealedMd.style?.prominence : undefined,
      barRole: sealedBar?.type === "indication" ? sealedBar.style?.role : undefined,
      barProminence: sealedBar?.type === "indication" ? sealedBar.style?.prominence : undefined,
    },
    live: {
      headerGutter: liveHeaderNode?.type === "indication" ? liveHeaderNode.gutter : undefined,
      barGutter: liveBar?.type === "indication" ? liveBar.gutter : undefined,
      kinds: liveBar?.type === "indication" ? (liveBar.children ?? []).map((c) => c.type) : [],
    },
  }).toEqual({
    sealed: {
      headerGutter: { kind: "top", glyph: "⁖" },
      barGutter: { kind: "rule", glyph: "┃" },
      markdown: expect.stringContaining("**options**"),
      role: "foreground",
      prominence: FgP.secondary,
      barRole: "foreground",
      barProminence: FgP.ghost,
    },
    live: {
      headerGutter: { kind: "top", glyph: "⁖" },
      barGutter: { kind: "rule", glyph: "┃" },
      kinds: ["markdown"],
    },
  });
});

test("ShadowStream squeeze + one birth", () => {
  const collapsed = ShadowStream({
    primitive: "thinking",
    lines: ["one", "two", "three"],
    state: "fully_collapsed",
    width: 40,
  });
  const buildUp = ShadowStream({
    primitive: "thinking",
    lines: ["a", "b"],
    state: "peek",
    height: 3,
    width: 40,
  });
  const squeeze = ShadowStream({
    primitive: "thinking",
    lines: ["old0", "old1", "mid", "new"],
    state: "peek",
    height: 3,
    width: 40,
  });
  const height1 = ShadowStream({
    primitive: "thinking",
    lines: ["only"],
    state: "peek",
    height: 1,
    width: 40,
    wavefront: true,
  });
  const births = ShadowStream({
    primitive: "thinking",
    lines: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"],
    state: "peek",
    height: 3,
    width: 40,
    birthFloor: 0.12,
    wavefront: true,
  });
  const squeezeFlat = collectText(squeeze).replaceAll("\n", "");
  const squeezeKids = squeeze.type === "flex" ? (squeeze.children ?? []) : [];
  const oldestRow = squeezeKids[0];
  const oldestFlat = oldestRow ? collectText(oldestRow).replaceAll("\n", "") : "";
  const buildKids = buildUp.type === "flex" ? (buildUp.children ?? []) : [];
  const buildOldest = buildKids[0];
  const buildOldestFlat = buildOldest ? collectText(buildOldest).replaceAll("\n", "") : "";
  const height1Kids = height1.type === "flex" ? (height1.children ?? []) : [];
  const height1Row = height1Kids[0];
  expect({
    collapsed: {
      type: collapsed.type,
      primitive: collectText(collapsed).includes("thinking"),
      body: ["one", "two", "three"].some((line) => collectText(collapsed).includes(line)),
    },
    buildUp: {
      primitive: collectText(buildUp).includes("thinking"),
      lines: ["a", "b"].every((line) => collectText(buildUp).includes(line)),
      rows: buildKids.length,
      oldestSharesPrimitive:
        buildOldest?.type === "flex" && buildOldestFlat.includes("thinking") && buildOldestFlat.includes("a"),
    },
    squeeze: {
      primitive: squeezeFlat.includes("thinking"),
      window: {
        old0: squeezeFlat.includes("old0"),
        old1: squeezeFlat.includes("old1"),
        mid: squeezeFlat.includes("mid"),
        newest: squeezeFlat.includes("new"),
      },
      oldestSharesPrimitive:
        oldestRow?.type === "flex" && oldestFlat.includes("thinking") && oldestFlat.includes("old1"),
    },
    height1: {
      births: liveKinds(height1).filter((k) => k === "birth").length,
      shares:
        height1Kids.length === 1 &&
        height1Row?.type === "flex" &&
        collectText(height1Row).includes("thinking") &&
        collectText(height1Row).includes("only"),
    },
    birth: {
      count: liveKinds(births).filter((k) => k === "birth").length,
      newest: liveBirthContents(births).some((t) => t.includes("cccccccccc")),
      older: liveBirthContents(births).some((t) => t.includes("aaaaaaaaaa") || t.includes("bbbbbbbbbb")),
    },
  }).toEqual({
    collapsed: { type: "flex", primitive: true, body: false },
    buildUp: { primitive: true, lines: true, rows: 2, oldestSharesPrimitive: true },
    squeeze: {
      primitive: true,
      window: { old0: false, old1: true, mid: true, newest: true },
      oldestSharesPrimitive: true,
    },
    height1: { births: 1, shares: true },
    birth: { count: 1, newest: true, older: false },
  });
});

test("summary thought is last annotation only — no peek, no expand", () => {
  const body = "**Assessing the repo**\n\n**Checking direct-header variants**";
  const sealed = ThinkingStream(
    {
      text: body,
      live: false,
      collapsed: false,
      latest: true,
      seal: "sealed",
      durationMs: 26_000,
      thoughtKind: "summary",
    },
    { key: "r-sum", width: 80 },
  );
  const live = ThinkingStream(
    {
      text: body,
      live: true,
      collapsed: true,
      seal: "live",
      durationMs: 26_000,
      thoughtKind: "summary",
    },
    { key: "r-sum-live", width: 80 },
  );
  const sealedFlat = collectText(sealed);
  const liveFlat = collectText(visible(live));
  expect({
    sealed: {
      type: sealed.type,
      intent: sealed.type === "indication" ? sealed.intent : undefined,
      onClick: "onClick" in sealed ? sealed.onClick : undefined,
      heading: (sealedFlat.match(/Checking direct-header variants/g) ?? []).length,
      earlier: sealedFlat.includes("Assessing"),
      duration: sealedFlat.replaceAll(/\s+/g, "").includes("Checkingdirect-headervariantsfor26s"),
    },
    live: {
      type: live.type,
      intent: live.type === "indication" ? live.intent : undefined,
      onClick: "onClick" in live ? live.onClick : undefined,
      heading: (liveFlat.match(/Checking direct-header variants/g) ?? []).length,
      earlier: liveFlat.includes("Assessing"),
      duration: liveFlat.replaceAll(/\s+/g, "").includes("Checkingdirect-headervariantsfor26s"),
    },
  }).toEqual({
    sealed: {
      type: "indication",
      intent: "none",
      onClick: undefined,
      heading: 1,
      earlier: false,
      duration: true,
    },
    live: {
      type: "indication",
      intent: "none",
      onClick: undefined,
      heading: 1,
      earlier: false,
      duration: true,
    },
  });
});

test("thinking peek overlays body on the header and renders markdown", () => {
  const node = ThinkingStream(
    {
      text: "weighing **options** quietly",
      live: true,
      collapsed: true,
      seal: "live",
      durationMs: 1200,
      peekLines: 3,
    },
    { key: "r-md", width: 48 },
  );
  const sum = visible(node);
  const kids = sum.type === "indication" ? (sum.children ?? []) : [];
  const row = kids[0];
  const joined = collectText(row ?? sum).replaceAll("\n", "");
  const flat = joined.replaceAll(/\s+/g, " ");
  expect({
    rows: kids.length,
    overlay: row?.type === "flex",
    header: /thinking/.test(flat),
    body: joined.includes("weighing options quietly"),
    glued: joined.includes("weighingoptions"),
    markers: joined.includes("**"),
    birth: findLiveBirth(sum)?.kind,
    voice: peekVoice(sum),
    gutter: sum.type === "indication" ? sum.style : undefined,
  }).toEqual({
    rows: 1,
    overlay: true,
    header: true,
    body: true,
    glued: false,
    markers: false,
    birth: undefined,
    voice: { role: "foreground", prominence: FgP.rising },
    gutter: { role: "foreground", prominence: FgP.secondary },
  });
});

test("PIN C8 wrapThoughtLines honors display width for CJK", () => {
  const cjk = "中文测试内容中文测试内容";
  const lines = wrapThoughtLines(cjk, 10);
  expect({
    wrapped: lines.length > 1,
    fits: lines.every((line) => displayWidth(line) <= 10),
  }).toEqual({
    wrapped: true,
    fits: true,
  });
});

function visible(node: LayoutNode): LayoutNode {
  if (node.type === "disclosure") {
    return node.collapsed !== false ? node.summary : (node.children?.[0] ?? node.summary);
  }
  return node;
}

function bodyText(node: LayoutNode): string {
  const v = visible(node);
  const child = v.type === "indication" ? v.children?.[0] : undefined;
  if (child && child.type === "text") return child.content;
  return "";
}

function newestPeekProminence(node: unknown): number | undefined {
  const v = visible(node as LayoutNode);
  if (v.type === "indication") return lastTextProminence(v.children?.at(-1));
  const kids = v.type === "flex" ? (v.children ?? []) : [];
  return lastTextProminence(kids.at(-1));
}

function lastTextProminence(node: unknown): number | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as { type?: string; style?: { prominence?: number }; children?: unknown[] };
  if (n.type === "text") return n.style?.prominence;
  const kids = n.children ?? [];
  for (let i = kids.length - 1; i >= 0; i--) {
    const hit = lastTextProminence(kids[i]);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function peekVoice(node: unknown): { role?: string; prominence?: number } | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as {
    type?: string;
    content?: string;
    style?: { role?: string; prominence?: number };
    children?: unknown[];
    summary?: unknown;
  };
  if (n.type === "text" && typeof n.content === "string" && /thinking/.test(n.content)) {
    return { role: n.style?.role, prominence: n.style?.prominence };
  }
  if (n.summary) {
    const hit = peekVoice(n.summary);
    if (hit) return hit;
  }
  for (const c of n.children ?? []) {
    const hit = peekVoice(c);
    if (hit) return hit;
  }
  return undefined;
}

function collectText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as {
    type?: string;
    content?: string;
    children?: unknown[];
    summary?: unknown;
  };
  const parts: string[] = [];
  if (n.type === "text" && typeof n.content === "string") parts.push(n.content);
  if (n.type === "markdown" && typeof n.content === "string") parts.push(n.content);
  if (n.summary) parts.push(collectText(n.summary));
  if (Array.isArray(n.children)) {
    for (const c of n.children) parts.push(collectText(c));
  }
  return parts.join("\n");
}

function gutterOf(node: LayoutNode) {
  const v = visible(node);
  if (v.type === "indication") return v.gutter;
  const kid = v.type === "flex" ? v.children?.[0] : undefined;
  return kid?.type === "indication" ? kid.gutter : undefined;
}

function extraGutterOf(node: LayoutNode) {
  const v = visible(node);
  if (v.type === "indication") return undefined;
  const kid = v.type === "flex" ? v.children?.[1] : undefined;
  return kid?.type === "indication" ? kid.gutter : undefined;
}

function findElapsed(node: unknown): unknown {
  if (!node || typeof node !== "object") return null;
  const n = node as {
    live?: { kind?: string };
    children?: unknown[];
    summary?: unknown;
  };
  if (n.live?.kind === "elapsed" || n.live?.kind === "countdown") return n.live;
  if (n.summary) {
    const hit = findElapsed(n.summary);
    if (hit) return hit;
  }
  for (const c of n.children ?? []) {
    const hit = findElapsed(c);
    if (hit) return hit;
  }
  return null;
}

function findLiveBirth(node: unknown): { kind: string; T: number; offset: number } | null {
  if (!node || typeof node !== "object") return null;
  const n = node as {
    live?: { kind?: string; T?: number; offset?: number };
    children?: unknown[];
    summary?: unknown;
  };
  if (n.live?.kind === "birth") {
    return {
      kind: "birth",
      T: n.live.T ?? 0,
      offset: n.live.offset ?? 0,
    };
  }
  if (n.summary) {
    const hit = findLiveBirth(n.summary);
    if (hit) return hit;
  }
  for (const c of n.children ?? []) {
    const hit = findLiveBirth(c);
    if (hit) return hit;
  }
  return null;
}

function liveKinds(node: unknown): Array<string | undefined> {
  if (!node || typeof node !== "object") return [];
  const n = node as { live?: { kind?: string }; children?: unknown[] };
  const out: Array<string | undefined> = [];
  if (n.live) out.push(n.live.kind);
  for (const c of n.children ?? []) out.push(...liveKinds(c));
  return out;
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
