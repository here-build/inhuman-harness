import { expect, test } from "vitest";

import { layout, type LayoutNode } from "../../layout/index.js";
import { FgP } from "../../lexicon/index.js";
import { rasterFrame, rasterLayout } from "../../runtime/raster.js";
import {
  actionHotkeys,
  autocompleteRemainder,
  commandToChoice,
  matchComposerCommand,
  type ComposerCommandChoice,
} from "../composer-command.js";
import { ComposerFrame } from "../composer-frame.js";
import {
  catalogKey,
  ensureChoiceKeys,
  paintPicker,
  peekScroll,
  reconcileSelectedKey,
  type PickerRow,
} from "../composer-picker.js";
import { bootSyntax, SyntaxLine } from "../syntax-boot.js";

const catalog = [
  { name: "connect", description: "Bind a source", aliases: ["conn"] },
  { name: "model", description: "Switch model" },
  { name: "quit", description: "Exit" },
];

test("slash-command match + remainder + hotkeys", () => {
  const matchOf = (draft: string) => {
    const m = matchComposerCommand(draft, catalog);
    return { selected: m.selected?.name ?? null, names: m.matches.map((c) => c.name) };
  };
  expect({
    idle: matchOf("hello"),
    conn: matchOf("/conn"),
    catalog: matchOf("/"),
  }).toEqual({
    idle: { selected: null, names: [] },
    conn: { selected: "connect", names: ["connect"] },
    catalog: { selected: "connect", names: ["connect", "model", "quit"] },
  });

  expect({
    verb: [
      autocompleteRemainder("/", "/connect"),
      autocompleteRemainder("/con", "/connect"),
      autocompleteRemainder("/connect", "/connect"),
    ],
    spaceChoice: [autocompleteRemainder("/connect", "openrouter"), autocompleteRemainder("/connect ", "openrouter")],
    prefix: [
      autocompleteRemainder("/connect open", "openrouter"),
      autocompleteRemainder("/connect open", "openai"),
      autocompleteRemainder("/connect openrouter", "openrouter"),
    ],
    multiWord: [
      autocompleteRemainder("/connect", "LM Studio"),
      autocompleteRemainder("/connect LM", "LM Studio"),
      autocompleteRemainder("/connect LM ", "LM Studio"),
      autocompleteRemainder("/connect LM St", "LM Studio"),
      autocompleteRemainder("/connect LM Studio", "LM Studio"),
      autocompleteRemainder("/connect Docker Model", "Docker Model Runner"),
    ],
    idle: [
      autocompleteRemainder("/connect gpt", "chatgpt"),
      autocompleteRemainder("hello", "openrouter"),
      autocompleteRemainder("/connect foo bar", "openrouter"),
    ],
    casing: autocompleteRemainder("/connect Open", "openrouter"),
  }).toEqual({
    verb: ["connect", "nect", ""],
    spaceChoice: [" openrouter", "openrouter"],
    prefix: ["router", "ai", ""],
    multiWord: [" LM Studio", " Studio", "Studio", "udio", "", " Runner"],
    idle: ["", "", ""],
    casing: "router",
  });

  expect({
    catalogSelect: actionHotkeys(commandToChoice(catalog[0]!).actions),
    join: actionHotkeys([
      { name: "select", displayName: "select", hotkey: "Tab" },
      { name: "connect/drop", displayName: "Remove connection", hotkey: "C-x" },
    ]),
    escape: actionHotkeys([
      { name: "ui/resolve", displayName: "Dismiss", hotkey: "Enter" },
      { name: "ui/resolve", displayName: "Dismiss", hotkey: "escape" },
    ]),
    controlX: actionHotkeys([{ name: "connect/drop", displayName: "Remove connection", hotkey: "control-x" }]),
  }).toEqual({
    catalogSelect: [{ key: "Enter", action: "select", event: "select" }],
    join: [
      { key: "Tab", action: "select", event: "select" },
      { key: "C-x", action: "Remove connection", event: "connect/drop" },
    ],
    escape: [
      { key: "Enter", action: "Dismiss", event: "ui/resolve" },
      { key: "Esc", action: "Dismiss", event: "ui/resolve" },
    ],
    controlX: [{ key: "Ctrl-x", action: "Remove connection", event: "connect/drop" }],
  });
});

test.each([
  { name: "stays when window has interior room", sel: 8, n: 15, v: 8, scroll: 4, out: 4 },
  { name: "indents below when sel is not last", sel: 8, n: 15, v: 8, scroll: 1, out: 2 },
  { name: "symmetric Up keeps a row above", sel: 5, n: 15, v: 8, scroll: 6, out: 4 },
  { name: "wraps sel=0 from max", sel: 0, n: 15, v: 8, scroll: 7, out: 0 },
  { name: "wraps sel=0 at 0", sel: 0, n: 15, v: 8, scroll: 0, out: 0 },
  { name: "wraps sel=N-1 from 0", sel: 14, n: 15, v: 8, scroll: 0, out: 7 },
  { name: "wraps sel=N-1 at max", sel: 14, n: 15, v: 8, scroll: 7, out: 7 },
  { name: "N===V", sel: 3, n: 8, v: 8, scroll: 2, out: 0 },
  { name: "N<V", sel: 0, n: 5, v: 8, scroll: 4, out: 0 },
  { name: "sel<0", sel: -1, n: 15, v: 8, scroll: 4, out: 0 },
  { name: "N===0 sel 0", sel: 0, n: 0, v: 8, scroll: 4, out: 0 },
  { name: "N===0 sel 3", sel: 3, n: 0, v: 8, scroll: 1, out: 0 },
  { name: "V===2 waives indent stay", sel: 5, n: 10, v: 2, scroll: 4, out: 4 },
  { name: "V===2 waives indent at sel", sel: 5, n: 10, v: 2, scroll: 5, out: 5 },
  {
    name: "does not peek offscreen",
    sel: 0,
    n: 15,
    v: 8,
    scroll: 5,
    out: 0,
    paint: true as const,
  },
])("peekScroll $name", (row) => {
  if (row.paint) {
    const rows: PickerRow[] = Array.from({ length: 15 }, (_, i) => ({ name: `row${i}` }));
    const paint = paintPicker({
      rows,
      selectedKey: "choice:0:row0",
      scrollOffset: 5,
      hoverKey: null,
      pressKey: null,
    });
    expect({
      first: paint.paintRowToKey[0],
      selectedIndex: paint.selectedIndex,
      glyphs: paint.bodyGlyphs,
    }).toEqual({
      first: "choice:5:row5",
      selectedIndex: 0,
      glyphs: Array.from({ length: paint.bodyGlyphs.length }, () => " "),
    });
    return;
  }
  expect(peekScroll(row.sel, row.n, row.v, row.scroll)).toBe(row.out);
});

test("picker key identity", () => {
  const rows: PickerRow[] = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
  expect({
    keep: reconcileSelectedKey("choice:1:beta", rows),
    fallback: reconcileSelectedKey("choice:9:gone", rows),
    emptyPrev: reconcileSelectedKey("choice:0:alpha", []),
    emptyNull: reconcileSelectedKey(null, []),
  }).toEqual({
    keep: "choice:1:beta",
    fallback: "choice:0:alpha",
    emptyPrev: null,
    emptyNull: null,
  });

  const omitted = ensureChoiceKeys([{ name: "openai" }]);
  const caller: PickerRow = { name: "openai" };
  ensureChoiceKeys([caller]);
  const first = ensureChoiceKeys([{ name: "LM Studio" }, { name: "local" }, { name: "OpenAI" }]);
  const withDup = ensureChoiceKeys([...first, { name: "OpenAI" }]);
  expect({
    omitted: omitted[0]!.key,
    callerKey: caller.key,
    firstOpenAI: first[2]!.key,
    stillFirst: withDup[2]!.key,
    secondOpenAI: withDup[3]!.key,
    catalogSlash: catalogKey("/connect"),
    catalogBare: catalogKey("connect"),
    catalogMint: ensureChoiceKeys([{ name: "/model" }], { catalog: true })[0]!.key,
  }).toEqual({
    omitted: "choice:0:openai",
    callerKey: undefined,
    firstOpenAI: "choice:2:OpenAI",
    stillFirst: "choice:2:OpenAI",
    secondOpenAI: "choice:3:OpenAI",
    catalogSlash: "catalog:connect",
    catalogBare: "catalog:connect",
    catalogMint: "catalog:model",
  });
});

test("ComposerFrame wiring", () => {
  const leaf = ComposerFrame({ inputValue: "hi", statusItems: ["Claude", "act"] }, { key: "composer", width: 40 });
  expect(leaf).toMatchObject({
    type: "chrome_frame",
    key: "composer",
    width: 40,
    draft: "hi",
    statusItems: ["Claude", "act"],
    glyph: " ",
  });

  const quota = ComposerFrame(
    {
      inputValue: "hi",
      statusItems: ["Claude"],
      quotaWindows: [{ remainingPercent: 50, resetAt: 3600 }],
      contextUsed: 10_000,
      contextLimit: 500_000,
      modHeld: true,
    },
    { key: "composer", width: 40 },
  );
  expect(quota).toMatchObject({
    quotaWindows: [{ remainingPercent: 50, resetAt: 3600 }],
    contextUsed: 10_000,
    contextLimit: 500_000,
    modHeld: true,
  });

  const hit = layout(leaf, { w: 40, h: 8 }).byKey.get("composer");
  expect(hit).toMatchObject({
    hitRect: { y: 1, h: 1 },
    element: { kind: "chrome_frame" },
  });

  const err = ComposerFrame(
    {
      inputValue: "",
      annotation: "ok",
      errorAnnotation: { level: "error", message: "missing path" },
    },
    { key: "composer", width: 40 },
  );
  expect(err).toMatchObject({
    type: "chrome_frame",
    annotation: "ok",
  });

  const stacked = ComposerFrame(
    {
      inputValue: "/con",
      commandChoices: [
        {
          name: "/connect",
          description: "Bind a source",
          actions: [{ name: "select", displayName: "select", hotkey: "Tab" }],
        },
      ],
    },
    { key: "composer", width: 48 },
  );
  const panel = slashPanel(stacked);
  const frame = chromeFrames(stacked).find((node) => node.omitTop === true);
  const capNode =
    stacked.type === "box" && stacked.children?.[0]?.type === "flex"
      ? stacked.children[0].children?.find((child) => child.type === "text")
      : undefined;
  expect({
    caption: capNode?.type === "text" ? capNode.content : undefined,
    selectedDesc: panel?.type === "chrome_frame" ? panel.picker?.rows[0]?.description : "missing",
    join: panel?.type === "chrome_frame" ? panel.joinBottom : undefined,
    omit: frame?.omitTop,
    hint: panel?.type === "chrome_frame" ? panel.hotkeys : undefined,
    glyphs: panel?.type === "chrome_frame" ? panel.bodyGlyphs : undefined,
  }).toEqual({
    caption: undefined,
    selectedDesc: "Bind a source",
    join: true,
    omit: true,
    hint: [{ key: "Tab", action: "select", event: "select" }],
    glyphs: ["›"],
  });

  const confirm = ComposerFrame(
    {
      inputValue: "",
      annotation: "Gmail **send email**",
      contourRole: "emphasis",
      hotkeys: [
        { key: "Enter", action: "Allow" },
        { key: "Esc", action: "Deny" },
      ],
      stackedBody: Array.from({ length: 16 }, (_, i) => `line-${i}`).join("\n"),
      stackedViewport: 8,
    },
    { key: "composer", width: 48 },
  );
  const overlayKids = confirm.type === "box" ? (confirm.children ?? []) : [];
  const overlayPanel = overlayKids[0];
  const overlayFrame = overlayKids[1];
  const coverage = overlayPanel?.type === "chrome_frame" ? overlayPanel.bodyRightCoverage : undefined;
  expect({
    types: overlayKids.map((c) => c.type),
    join: overlayPanel?.type === "chrome_frame" ? overlayPanel.joinBottom : undefined,
    omit: overlayFrame?.type === "chrome_frame" ? overlayFrame.omitTop : undefined,
    hint: overlayPanel?.type === "chrome_frame" ? overlayPanel.hotkeys : undefined,
    rows: overlayPanel?.type === "chrome_frame" ? overlayPanel.bodySegRows?.length : undefined,
    thumb: coverage?.some((cell) => cell > 0),
    panelContour: overlayPanel?.type === "chrome_frame" ? overlayPanel.contourRole : undefined,
    frameContour: overlayFrame?.type === "chrome_frame" ? overlayFrame.contourRole : undefined,
  }).toEqual({
    types: ["chrome_frame", "chrome_frame"],
    join: true,
    omit: true,
    hint: [
      { key: "Enter", action: "Allow" },
      { key: "Esc", action: "Deny" },
    ],
    rows: 8,
    thumb: true,
    panelContour: "emphasis",
    frameContour: "emphasis",
  });
  expect(overlayPanel?.type === "chrome_frame" ? overlayPanel.bodyGlyphs : undefined).toEqual(
    Array.from({ length: 8 }, () => " "),
  );
  const shellAsk = ComposerFrame(
    {
      inputValue: "",
      annotation: "run command",
      contourRole: "emphasis",
      stackedBody: "rm file",
      stackedLang: "bash",
      stackedViewport: 8,
      hotkeys: [
        { key: "Enter", action: "Allow" },
        { key: "Esc", action: "Deny" },
      ],
    },
    { key: "composer:frame", width: 80 },
  );
  const shellPaint = rasterFrame(shellAsk, 80, 10);
  const shellCorners: string[] = [];
  for (let y = 0; y < shellPaint.buffer.height; y++) {
    for (let x = 0; x < shellPaint.buffer.width; x++) {
      const cell = shellPaint.buffer.cells[y * shellPaint.buffer.width + x];
      if (cell?.ch === "╭" || cell?.ch === "╰" || cell?.ch === "├" || cell?.ch === "┤") {
        shellCorners.push(`${cell.ch}:${cell.style?.role ?? "none"}`);
      }
    }
  }
  expect({
    roles: [...new Set(shellCorners.map((c) => c.slice(2)))],
    top: shellCorners.some((c) => c.startsWith("╭:")),
    join: shellCorners.some((c) => c.startsWith("├:")),
    bottom: shellCorners.some((c) => c.startsWith("╰:")),
  }).toEqual({
    roles: ["emphasis"],
    top: true,
    join: true,
    bottom: true,
  });

  const shortcuts = slashPanel(
    ComposerFrame(
      {
        inputValue: "/",
        hotkeys: [{ key: "Esc", action: "clear" }],
        commands: [
          { name: "connect", description: "Bind a source" },
          { name: "model", description: "Session model" },
        ],
      },
      { key: "composer", width: 56 },
    ),
  );
  const overlay = ComposerFrame(
    {
      inputValue: "",
      interactive: false,
      placeholder: "Remove work?",
      commandAction: {
        name: "ui/resolve",
        displayName: "Confirm",
        actions: [],
      },
      commandChoices: [],
    },
    { key: "composer", width: 40 },
  );
  const draft = chromeFrames(overlay).find((node) => node.interactive === false) ?? chromeFrames(overlay).at(-1);
  expect({
    shortcuts: shortcuts?.hotkeys,
    overlay: {
      cursor: draft?.cursor,
      glyph: draft?.glyph,
      interactive: draft?.interactive,
      completion: draft?.completion,
    },
  }).toEqual({
    shortcuts: [{ key: "Esc", action: "clear" }],
    overlay: {
      cursor: undefined,
      glyph: " ",
      interactive: false,
      completion: undefined,
    },
  });

  const selected = slashPanel(
    ComposerFrame(
      {
        inputValue: "/",
        selectedCommandIndex: 1,
        commands: [
          { name: "connect", description: "Bind a source" },
          { name: "model", description: "Session model" },
        ],
      },
      { key: "composer", width: 48 },
    ),
  );
  const hover = slashPanel(
    ComposerFrame(
      {
        commandChoices: [
          { name: "a", actions: [] },
          { name: "b", actions: [] },
          { name: "c", actions: [] },
        ],
        selectedCommandIndex: 0,
        pickerHoverKey: "choice:2:c",
      },
      { key: "composer", width: 48 },
    ),
  );
  const peek = slashPanel(
    ComposerFrame(
      {
        inputValue: "/connect",
        commandChoices: fifteenChoices(),
        selectedCommandIndex: 7,
        scrollOffset: 1,
      },
      { key: "composer", width: 48 },
    ),
  );
  expect({
    selected: selected?.bodyGlyphs,
    hover: hover?.bodyGlyphs,
    peek: {
      userSelect: peek?.bodyUserSelect,
      rowCount: peek?.picker?.rows.length,
      glyphs: peek?.bodyGlyphs,
      names: (peek?.bodySegRows ?? []).map((row) => row[0]?.text),
    },
  }).toEqual({
    selected: [" ", "›"],
    hover: ["›", " ", " "],
    peek: {
      userSelect: "none",
      rowCount: 15,
      glyphs: [" ", " ", " ", " ", " ", " ", "›", " "],
      names: [
        "Docker Model Runner",
        "choice-03",
        "choice-04",
        "choice-05",
        "choice-06",
        "choice-07",
        "choice-08",
        "choice-09",
      ],
    },
  });
});

test("numbered stacked body: counter in the mark cell, first row primary", () => {
  const node = ComposerFrame(
    {
      inputValue: "",
      stackedBody: "Keep AUTH_SECRET out of the module scope.\nAlso rotate the cookie name on logout.",
      stackedNumbered: true,
    },
    { key: "composer", width: 48 },
  );
  const panel = slashPanel(node);
  expect({
    glyphs: panel?.type === "chrome_frame" ? panel.bodyGlyphs : undefined,
    segs: panel?.type === "chrome_frame" ? panel.bodySegRows : undefined,
  }).toEqual({
    glyphs: ["1", "2"],
    segs: [
      [
        {
          text: "Keep AUTH_SECRET out of the module scope.",
          role: "foreground",
          prominence: FgP.primary,
        },
      ],
      [{ text: "Also rotate the cookie name on logout.", role: "muted", prominence: FgP.ghost }],
    ],
  });
  const chars = rasterLayout(node, 48, 8);
  expect({
    first: chars.find((row) => row.includes("Keep AUTH_SECRET"))?.slice(0, 8),
    second: chars.find((row) => row.includes("Also rotate"))?.slice(0, 8),
  }).toEqual({
    first: "│1 Keep ",
    second: "│2 Also ",
  });
});

test("slash description stays on the selected row; joinAnnotation rides ├┤", () => {
  const frame = ComposerFrame(
    {
      inputValue: "/",
      annotation: "Auth refactor",
      commandChoices: [
        {
          name: "/connect",
          description: "Manage provider connections",
          actions: [{ name: "select", displayName: "select", hotkey: "Tab" }],
        },
      ],
    },
    { key: "composer:frame", width: 48 },
  );
  const caption = frame.type === "box" ? frame.children?.[0] : undefined;
  const captionText = caption?.type === "flex" ? caption.children?.find((child) => child.type === "text") : undefined;
  const panel = slashPanel(frame);
  expect({
    caption: captionText?.type === "text" ? captionText.content : undefined,
    title: panel?.type === "chrome_frame" ? panel.annotation : undefined,
    selectedDesc: panel?.type === "chrome_frame" ? panel.picker?.rows[0]?.description : "missing",
  }).toEqual({
    caption: undefined,
    title: "Auth refactor",
    selectedDesc: "Manage provider connections",
  });

  const solo = ComposerFrame(
    {
      inputValue: "hi",
      annotation: "Auth refactor",
      commandAnnotation: "Bind a source",
    },
    { key: "composer", width: 40 },
  );
  expect(solo).toMatchObject({ type: "chrome_frame", annotation: "Bind a source" });

  const shell = ComposerFrame(
    {
      inputValue: "",
      annotation: "run command",
      joinAnnotation: "Auth refactor",
      stackedBody: "rm file",
      stackedLang: "bash",
      hotkeys: [
        { key: "Enter", action: "Allow" },
        { key: "Esc", action: "Deny" },
      ],
    },
    { key: "composer:frame", width: 48 },
  );
  const overlay = slashPanel(shell);
  expect({
    identity: overlay?.type === "chrome_frame" ? overlay.annotation : undefined,
    title: overlay?.type === "chrome_frame" ? overlay.joinAnnotation : undefined,
  }).toEqual({
    identity: "run command",
    title: "Auth refactor",
  });
});

test("stackedLang bash paints shiki tokens on the overlay", async () => {
  await bootSyntax("dark");
  const node = ComposerFrame(
    {
      inputValue: "",
      annotation: "run command",
      hotkeys: [
        { key: "Enter", action: "Allow" },
        { key: "Esc", action: "Deny" },
      ],
      stackedBody: "echo hello && ls",
      stackedLang: "bash",
    },
    { key: "composer", width: 48 },
  );
  const panel = slashPanel(node);
  if (panel?.type !== "chrome_frame") throw new Error("expected overlay");
  const segs = (panel.bodySegRows ?? []).flat();
  expect({
    annotation: panel.annotation,
    text: segs.map((seg) => seg.text).join(""),
    code: segs.some((seg) => seg.role === "code"),
  }).toEqual({
    annotation: "run command",
    text: "echo hello && ls",
    code: true,
  });
});

test("SyntaxLine bash tokens take the code role when warm", async () => {
  await bootSyntax("dark");
  const node = SyntaxLine("echo hello", { lang: "bash", key: "cmd", width: 40 });
  const texts: Array<{ text: string; role?: string }> = [];
  const walk = (n: LayoutNode): void => {
    if (n.type === "text") {
      texts.push({
        text: n.content,
        role: n.style?.role,
      });
    }
    if ("children" in n && Array.isArray(n.children)) {
      for (const child of n.children) walk(child);
    }
  };
  walk(node);
  expect({
    joined: texts.map((row) => row.text).join(""),
    code: texts.some((row) => row.role === "code"),
  }).toEqual({
    joined: "echo hello",
    code: true,
  });
});

function chromeFrames(node: LayoutNode): Array<Extract<LayoutNode, { type: "chrome_frame" }>> {
  const frames: Array<Extract<LayoutNode, { type: "chrome_frame" }>> = [];
  const walk = (n: LayoutNode): void => {
    if (n.type === "chrome_frame") frames.push(n);
    if ("children" in n && Array.isArray(n.children)) {
      for (const child of n.children) walk(child);
    }
  };
  walk(node);
  return frames;
}

function slashPanel(node: LayoutNode) {
  return chromeFrames(node).find((frame) => frame.key === "slash-complete");
}

function fifteenChoices(): ComposerCommandChoice[] {
  const names = [
    "LM Studio",
    "Docker Model Runner",
    ...Array.from({ length: 13 }, (_, i) => `choice-${String(i + 3).padStart(2, "0")}`),
  ];
  return names.map((name) => ({
    name,
    actions: [{ name: "select", displayName: "select", hotkey: "Enter" }],
  }));
}
