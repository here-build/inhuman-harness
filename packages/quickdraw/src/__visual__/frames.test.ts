import { expect, test } from "vitest";

import { dumpFrame, type FrameDump, type NodeDump } from "./_helpers.js";
import type { LayoutNode } from "../layout/index.js";
import { ComposerFrame } from "../widgets/composer-frame.js";
import { expandWidgetPriors } from "../widgets/expand.js";
import { Diff, Indication, Markdown, ShadowStream, Text, ThinkingStream } from "../widgets/index.js";

const W = 40;
const H = 12;

function findDump(node: NodeDump, pred: (n: NodeDump) => boolean): NodeDump | undefined {
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findDump(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

function gutterKind(node: NodeDump): string | undefined {
  if (typeof node.gutter !== "object" || node.gutter === null) return undefined;
  const kind = (node.gutter as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

/** Viewport dump minus trailing empty rows (geometry oracle). */
function frame(
  node: LayoutNode,
  w: number,
  h: number,
  opts?: { nowMs?: number; birth?: ReadonlyMap<string, number> },
): FrameDump {
  const dump = dumpFrame(node, w, h, opts);
  const chars = [...dump.chars];
  while (chars.length > 0 && chars[chars.length - 1] === "") chars.pop();
  return { ...dump, chars };
}

test("chrome empty composer (placeholder)", () => {
  expect(
    frame(ComposerFrame({ inputValue: "", placeholder: "Type a message…" }, { key: "composer", width: W }), W, H),
  ).toMatchObject({
    size: { w: W, h: H },
    tree: {
      type: "chrome_frame",
      key: "composer",
      placeholder: "Type a message…",
      texts: ["Type a message…"],
    },
    chars: [
      "╭──────────────────────────────────────╮",
      "│  Type a message…                     │",
      "╰──────────────────────────────────────╯",
    ],
  });
});

test("chrome draft + status items", () => {
  expect(
    frame(ComposerFrame({ inputValue: "hello", statusItems: ["grok-4", "grok"] }, { key: "composer", width: W }), W, H),
  ).toMatchObject({
    tree: {
      type: "chrome_frame",
      draft: "hello",
      statusItems: ["grok-4", "grok"],
      texts: expect.arrayContaining(["hello"]),
    },
    chars: [
      "╭──────────────────────────────────────╮",
      "│  hello                               │",
      "╰────────────────────── grok-4 · grok ─╯",
    ],
  });
});

test("chrome T-join picker stacked above omnibox", () => {
  expect(
    frame(
      ComposerFrame(
        {
          inputValue: "/con",
          commandChoices: [
            {
              name: "/connect",
              description: "Bind a source",
              actions: [{ name: "select", displayName: "select", hotkey: "Tab" }],
            },
            {
              name: "/model",
              description: "Session model",
              actions: [{ name: "select", displayName: "select", hotkey: "Tab" }],
            },
          ],
        },
        { key: "composer", width: 48 },
      ),
      48,
      H,
    ),
  ).toMatchObject({
    tree: {
      type: "box",
      children: [
        {
          type: "chrome_frame",
          glyphs: ["›", " "],
          texts: expect.arrayContaining([expect.stringContaining("/connect"), expect.stringContaining("/model")]),
        },
        {
          type: "chrome_frame",
          draft: "/con",
          completion: "nect",
        },
      ],
    },
    chars: expect.arrayContaining([
      expect.stringMatching(/^╭/),
      expect.stringContaining("/connect"),
      expect.stringMatching(/^├.*Tab: select/),
      expect.stringMatching(/┤$/),
      expect.stringContaining("/con"),
    ]),
  });
});

test("chrome progress rail (fill present, no % text)", () => {
  const painted = frame(
    ComposerFrame({ inputValue: "hi", progress: 0.35, statusItems: ["act"] }, { key: "composer", width: W }),
    W,
    H,
  );
  expect({
    tree: painted.tree,
    chars: painted.chars,
    hasPct: /\d+%/.test(painted.chars.join("\n")),
    hasFill: painted.chars.some((row) => row.includes("─")),
  }).toMatchObject({
    tree: {
      type: "chrome_frame",
      draft: "hi",
      progress: 0.35,
      statusItems: ["act"],
    },
    chars: expect.arrayContaining([expect.stringMatching(/ hi/), expect.stringContaining("act")]),
    hasPct: false,
    hasFill: true,
  });
});

test("indication blockquote: rule glyph every row, body col ≥ 2", () => {
  const painted = frame(
    Indication({
      key: "bq",
      gutter: { kind: "rule", glyph: "│" },
      children: [Text("first", { key: "a" }), Text("second", { key: "b" }), Text("third", { key: "c" })],
    }),
    20,
    5,
  );
  expect({
    tree: painted.tree,
    row0: painted.chars[0],
    row1: painted.chars[1],
    row2: painted.chars[2],
    lead: painted.chars[0]?.[0],
    glyph: painted.chars[0]?.[1],
    gap: painted.chars[0]?.[2],
    body: painted.chars[0]?.[3],
  }).toMatchObject({
    tree: {
      type: "indication",
      gutter: { kind: "rule", glyph: "│" },
      texts: ["first", "second", "third"],
    },
    lead: " ",
    glyph: "│",
    gap: " ",
    body: "f",
    row0: expect.stringMatching(/^ │ first/),
    row1: expect.stringMatching(/^ │ second/),
    row2: expect.stringMatching(/^ │ third/),
  });
});

test("indication composer prompt: glyph first row only", () => {
  expect(
    frame(
      Indication({
        key: "composer",
        gutter: { kind: "top", glyph: "❯" },
        children: [Text("hi\nworld", { whiteSpace: "pre-wrap" })],
      }),
      20,
      4,
    ),
  ).toMatchObject({
    tree: {
      type: "indication",
      gutter: { kind: "top", glyph: "❯" },
      texts: ["hi\nworld"],
    },
    chars: [expect.stringMatching(/^ ❯ hi/), expect.stringMatching(/^ {3}w/)],
  });
});

test("indication corners live (no closer) vs sealed ∵ · ∴", () => {
  const live = frame(
    Indication({
      key: "live",
      gutter: { kind: "corners", top: "∵", mid: "·", bottom: null },
      children: [Text("a", { key: "a" }), Text("b", { key: "b" })],
    }),
    20,
    3,
  );
  const sealed = frame(
    Indication({
      key: "thought",
      gutter: { kind: "corners", top: "∵", mid: "·", bottom: "∴" },
      children: [Text("a", { key: "a" }), Text("b", { key: "b" }), Text("c", { key: "c" })],
    }),
    20,
    5,
  );
  expect({ live, sealed }).toMatchObject({
    live: {
      tree: {
        type: "indication",
        gutter: { kind: "corners", top: "∵", mid: "·", bottom: null },
      },
      chars: [expect.stringMatching(/^ ∵ a/), expect.stringMatching(/^ · b/)],
    },
    sealed: {
      tree: {
        type: "indication",
        gutter: { kind: "corners", top: "∵", mid: "·", bottom: "∴" },
      },
      chars: [expect.stringMatching(/^ ∵ a/), expect.stringMatching(/^ · b/), expect.stringMatching(/^ ∴ c/)],
    },
  });
});

test("thinking omitted copy", () => {
  expect(
    frame(
      ThinkingStream(
        {
          text: "",
          live: false,
          seal: "sealed",
          durationMs: 3200,
          agentLabel: "Claude",
        },
        { key: "r-empty", width: 48 },
      ),
      48,
      8,
    ),
  ).toMatchObject({
    tree: {
      type: "indication",
      gutter: { kind: "top", glyph: "⁖" },
      texts: ["Claude did not share the thinking · 3.2s"],
    },
    chars: [expect.stringMatching(/^ ⁖ Claude did not share the thinking/)],
  });
});

test("thinking live peek overlays markdown body on the header row", () => {
  const painted = frame(
    ThinkingStream(
      {
        text: "weighing **options**",
        live: true,
        collapsed: true,
        seal: "live",
        durationMs: 1200,
        peekLines: 3,
      },
      { key: "r-overlay", width: W },
    ),
    W,
    H,
    { nowMs: 0 },
  );
  const first = painted.chars.find((row) => row.trim().length > 0) ?? "";
  const compact = first.replaceAll(/\s+/g, " ");
  expect({
    tree: painted.tree,
    spinner: painted.chars[0]?.[1],
    headerAndBody: /thinking/.test(compact) && /weighing/.test(compact),
    options: compact.includes("weighing options"),
    glued: compact.includes("weighingoptions"),
    markers: compact.includes("**"),
    rows: painted.chars.filter((row) => row.trim().length > 0).length,
  }).toMatchObject({
    tree: { type: "disclosure", collapsed: true },
    spinner: "⠋",
    headerAndBody: true,
    options: true,
    glued: false,
    markers: false,
    rows: 1,
  });
});

test("thinking live peek (spinner + shadow window)", () => {
  const painted = frame(
    ThinkingStream(
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
      { key: "r-live", width: W },
    ),
    W,
    H,
    { nowMs: 0 },
  );
  const compact = painted.chars.join("").replaceAll(/\s+/g, "");
  expect({
    tree: painted.tree,
    peek: findDump(painted.tree, (n) => n.key === "r-live:sum"),
    joined: painted.chars.join("\n").replaceAll(/\s+/g, " "),
    spinner: painted.chars[0]?.[1],
    hasNewest: /fourthnewest/.test(compact),
    hasOldest: /firstpremise/.test(compact),
  }).toMatchObject({
    tree: { type: "disclosure", collapsed: true },
    peek: {
      type: "indication",
      gutter: { kind: "top", glyph: "⁖" },
    },
    spinner: "⁖",
    joined: expect.stringMatching(/thinking/),
    hasNewest: true,
    hasOldest: false,
  });
});

test("thinking summary is last annotation only", () => {
  const painted = frame(
    ThinkingStream(
      {
        text: "**Assessing the repo**\n\n**Checking direct-header variants**",
        live: false,
        collapsed: true,
        latest: true,
        seal: "sealed",
        durationMs: 26_000,
        thoughtKind: "summary",
      },
      { key: "r-sum", width: 64 },
    ),
    64,
    H,
  );
  const joined = painted.chars.join(" ").replaceAll(/\s+/g, " ");
  expect({
    tree: painted.tree,
    lines: painted.chars.filter((row) => row.trim().length > 0).length,
    headingHits: joined.split("Checking").length - 1,
    earlier: /Assessing/.test(joined),
    joined,
  }).toMatchObject({
    tree: {
      type: "indication",
      gutter: { kind: "top", glyph: "⁖" },
      texts: [expect.stringMatching(/Checking direct-header variants for 26s/)],
    },
    lines: 1,
    headingHits: 1,
    earlier: false,
    joined: expect.stringMatching(/Checking direct-header variants for 26s/),
  });
});

test("thinking sealed compact is one faded line", () => {
  const painted = frame(
    ThinkingStream(
      {
        text: "suggested to do X, I think that is good",
        live: false,
        collapsed: true,
        seal: "sealed",
        durationMs: 5000,
      },
      { key: "r-compact", width: W },
    ),
    W,
    H,
  );
  expect({
    tree: painted.tree,
    lines: painted.chars.filter((row) => row.trim().length > 0).length,
    joined: painted.chars.join(" ").replaceAll(/\s+/g, " "),
  }).toMatchObject({
    tree: { type: "disclosure", collapsed: true },
    lines: 1,
    joined: expect.stringMatching(/thought for 5s.*good/),
  });
});

test("thinking sealed expanded", () => {
  const painted = frame(
    expandWidgetPriors(
      ThinkingStream(
        {
          text: "weighing **options** quietly",
          live: false,
          collapsed: false,
          seal: "sealed",
          durationMs: 1000,
        },
        { key: "r3", width: W },
      ),
      { width: W },
    ),
    W,
    H,
  );
  expect({
    tree: painted.tree,
    open: findDump(painted.tree, (n) => n.key === "r3:open" && gutterKind(n) === "rule"),
    chars: painted.chars,
  }).toMatchObject({
    tree: {
      type: "disclosure",
      collapsed: false,
      texts: expect.arrayContaining([
        expect.stringContaining("thought for"),
        expect.stringContaining("weighing"),
        expect.stringContaining("options"),
      ]),
    },
    open: {
      type: "indication",
      gutter: { kind: "rule", glyph: "┃" },
    },
    chars: expect.arrayContaining([
      expect.stringMatching(/^ ⁖/),
      expect.stringMatching(/^ ┃/),
      expect.stringContaining("options"),
    ]),
  });
});

test("shadow fully_collapsed + peek squeeze", () => {
  const collapsed = frame(
    ShadowStream({
      primitive: "thinking",
      lines: ["one", "two", "three"],
      state: "fully_collapsed",
      width: W,
    }),
    W,
    8,
  );
  const squeeze = frame(
    ShadowStream({
      primitive: "thinking",
      lines: ["old0", "old1", "mid", "new"],
      state: "peek",
      height: 3,
      width: W,
    }),
    W,
    8,
  );
  const squeezeJoined = squeeze.chars.join("\n");
  expect({
    collapsed: {
      tree: collapsed.tree,
      joined: collapsed.chars.join("\n"),
      hasBody: collapsed.chars.join("\n").includes("one"),
    },
    squeeze: {
      joined: squeezeJoined.replaceAll("\n", ""),
      hasOld0: squeezeJoined.includes("old0"),
      hasOld1: squeezeJoined.includes("old1"),
      hasMid: squeezeJoined.includes("mid"),
      hasNew: squeezeJoined.includes("new"),
    },
  }).toMatchObject({
    collapsed: {
      tree: { texts: expect.arrayContaining([expect.stringContaining("thinking")]) },
      joined: expect.stringMatching(/▸ thinking/),
      hasBody: false,
    },
    squeeze: {
      joined: expect.stringMatching(/thinking[\s\S]*new/),
      hasOld0: false,
      hasOld1: true,
      hasMid: true,
      hasNew: true,
    },
  });
});

test("markdown heading + list + strike + blockquote + table", () => {
  const painted = frame(
    expandWidgetPriors(
      Markdown(
        [
          "# Title",
          "",
          "- alpha",
          "- beta",
          "",
          "keep ~~remove~~ keep",
          "",
          "> quoted line",
          "",
          "| check | status | ms |",
          "|---|---|---|",
          "| compile | ok | 812 |",
        ].join("\n"),
        { key: "md" },
      ),
      { width: W },
    ),
    W,
    20,
  );
  expect({
    tree: painted.tree,
    strike: findDump(painted.tree, (n) => n.strike === true),
    quote: findDump(painted.tree, (n) => gutterKind(n) === "rule"),
    table: findDump(painted.tree, (n) => n.type === "grid"),
    chars: painted.chars,
  }).toMatchObject({
    tree: {
      type: "box",
      texts: expect.arrayContaining([
        expect.stringContaining("Title"),
        expect.stringContaining("alpha"),
        expect.stringContaining("remove"),
        expect.stringContaining("quoted"),
        expect.stringContaining("check"),
        expect.stringContaining("compile"),
      ]),
    },
    strike: { strike: true, texts: expect.arrayContaining(["remove"]) },
    quote: { type: "indication", gutter: { kind: "rule", glyph: "│" } },
    table: {
      type: "grid",
      texts: expect.arrayContaining(["check", "status", "ms", "compile", "ok", "812"]),
    },
    chars: expect.arrayContaining([
      expect.stringContaining("Title"),
      expect.stringContaining("quoted"),
      expect.stringMatching(/check/),
    ]),
  });
});

test("blockquote wraps inside indication inset", () => {
  const long =
    "Use period, establish or retrieve a baseline, check for newly added comments on each execution, and end the schedule when TAILQUOTE";
  const painted = frame(
    expandWidgetPriors(Markdown(`> **Recurring monitoring:** ${long}`, { key: "md" }), {
      width: W,
    }),
    W,
    16,
  );
  const joined = painted.chars.join("\n");
  expect({
    tail: joined.includes("TAILQUOTE"),
    bars: painted.chars.filter((row) => row.includes("│")).length > 1,
    cutoff: painted.chars.some((row) => /whe\s*$/.test(row)),
  }).toEqual({ tail: true, bars: true, cutoff: false });
});

test("diff unified + split (L/R)", () => {
  const unified = frame(
    expandWidgetPriors(
      Diff({
        old: "a\nb\nc\n",
        new: "a\nB\nc\n",
        path: "sample.ts",
        width: W,
        mode: "unified",
        key: "d",
        noHighlight: true,
      }),
    ),
    W,
    H,
  );
  const split = frame(
    expandWidgetPriors(
      Diff({
        old: "a\nb\n",
        new: "a\nc\n",
        path: "s.ts",
        width: 100,
        mode: "split",
        key: "split",
        noHighlight: true,
      }),
    ),
    100,
    H,
  );
  expect({
    unified,
    add: findDump(unified.tree, (n) => n.role === "diff_add" || n.bgRole === "diff_add"),
    del: findDump(unified.tree, (n) => n.role === "diff_del" || n.bgRole === "diff_del"),
    split,
    splitL: findDump(split.tree, (n) => (n.key ?? "").includes(":L")),
    splitR: findDump(split.tree, (n) => (n.key ?? "").includes(":R")),
  }).toMatchObject({
    unified: {
      tree: {
        type: "indentation_exception",
        kind: "diff",
        texts: expect.arrayContaining([expect.stringContaining("sample.ts · proposed")]),
      },
      chars: expect.arrayContaining([expect.stringContaining("proposed"), expect.stringContaining("▌")]),
    },
    add: expect.objectContaining({}),
    del: expect.objectContaining({}),
    split: {
      tree: { type: "indentation_exception", kind: "diff" },
    },
    splitL: expect.objectContaining({ key: expect.stringContaining(":L") }),
    splitR: expect.objectContaining({ key: expect.stringContaining(":R") }),
  });
});

test("grid inventory table shape", () => {
  const table: LayoutNode = {
    type: "grid",
    key: "t",
    style: {
      columns: ["auto", "auto", "auto"],
      lines: "inner",
      lineStyle: { dim: true, fg: 240 },
      cellPad: { x: 1 },
      columnGap: 1,
      rowGap: 1,
    },
    children: [
      { type: "text", content: "check", style: { bold: true }, whiteSpace: "nowrap" },
      { type: "text", content: "status", style: { bold: true }, whiteSpace: "nowrap" },
      { type: "text", content: "ms", style: { bold: true }, whiteSpace: "nowrap" },
      { type: "text", content: "compile", whiteSpace: "nowrap" },
      { type: "text", content: "ok", whiteSpace: "nowrap" },
      { type: "text", content: "812", whiteSpace: "nowrap" },
      { type: "text", content: "test", whiteSpace: "nowrap" },
      { type: "text", content: "ok", whiteSpace: "nowrap" },
      { type: "text", content: "4021", whiteSpace: "nowrap" },
    ],
  };
  expect(frame(table, W, 10)).toMatchObject({
    size: { w: W, h: 10 },
    tree: {
      type: "grid",
      texts: expect.arrayContaining(["check", "status", "ms", "compile", "ok", "812", "test", "4021"]),
    },
    chars: [
      " check   │ status │ ms",
      "─────────┼────────┼──────",
      " compile │ ok     │ 812",
      "─────────┼────────┼──────",
      " test    │ ok     │ 4021",
    ],
  });
});

test("composer remainder muted after draft", () => {
  expect(
    frame(
      ComposerFrame(
        {
          inputValue: "/connect",
          commandChoices: [
            {
              name: "openrouter",
              actions: [{ name: "select", displayName: "select", hotkey: "Enter" }],
            },
          ],
        },
        { key: "composer", width: 48 },
      ),
      48,
      H,
    ),
  ).toMatchObject({
    tree: {
      type: "box",
      children: [
        { glyphs: ["›"], texts: expect.arrayContaining([expect.stringContaining("openrouter")]) },
        { type: "chrome_frame", draft: "/connect", completion: " openrouter" },
      ],
    },
    chars: expect.arrayContaining([expect.stringContaining("/connect"), expect.stringContaining("openrouter")]),
  });
});

test("composer href accent underline row", () => {
  expect(
    frame(
      ComposerFrame(
        {
          commandAction: {
            name: "Authorize OpenRouter in the browser",
            displayName: "Authorize OpenRouter in the browser",
            actions: [{ name: "ui/resolve", displayName: "Cancel", hotkey: "escape" }],
            href: "https://openrouter.ai/auth?code_challenge=abc",
          },
          commandChoices: [],
        },
        { key: "composer", width: 56 },
      ),
      56,
      H,
    ),
  ).toMatchObject({
    tree: {
      type: "box",
      children: expect.arrayContaining([
        expect.objectContaining({
          type: "chrome_frame",
          href: "https://openrouter.ai/auth?code_challenge=abc",
          underline: true,
          texts: expect.arrayContaining([expect.stringContaining("Authorize OpenRouter")]),
        }),
      ]),
    },
    chars: expect.arrayContaining([expect.stringContaining("Authorize OpenRouter")]),
  });
});

test("selection highlight on composer: content cells, not │", () => {
  const painted = frame(
    ComposerFrame({ inputValue: "hello world", cursor: 5, mark: 0 }, { key: "composer", width: W }),
    W,
    H,
  );
  expect({
    tree: painted.tree,
    chars: painted.chars,
    body: painted.chars[1],
  }).toMatchObject({
    tree: { type: "chrome_frame", draft: "hello world" },
    chars: [
      "╭──────────────────────────────────────╮",
      "│  hello world                         │",
      "╰──────────────────────────────────────╯",
    ],
    body: "│  hello world                         │",
  });
});

test("birth wavefront: two maps, live birth in tree", () => {
  const node = ShadowStream({
    key: "s1",
    primitive: "thinking",
    lines: ["older full width lane", "newest tip line content"],
    state: "peek",
    height: 3,
    width: W,
    birthFloor: 0.12,
    tipWindow: 12,
    wavefront: true,
  });
  const rest = frame(node, W, 8, { nowMs: 0 });
  const early = frame(node, W, 8, {
    nowMs: 16,
    birth: new Map([["s1", 2]]),
  });
  expect({
    restLive: findDump(rest.tree, (n) => (n.live as { kind?: string } | undefined)?.kind === "birth")?.live,
    earlyLive: findDump(early.tree, (n) => (n.live as { kind?: string } | undefined)?.kind === "birth")?.live,
    restChars: rest.chars,
    earlyChars: early.chars,
  }).toMatchObject({
    restLive: { kind: "birth", siteId: "s1" },
    earlyLive: { kind: "birth", siteId: "s1" },
    restChars: expect.arrayContaining([expect.stringContaining("newest tip")]),
    earlyChars: expect.arrayContaining([expect.stringContaining("newest tip")]),
  });
});
