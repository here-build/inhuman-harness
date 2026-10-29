import {
  ComposerFrame,
  Markdown,
  Speech,
  Text,
  ThinkingStream,
  peekScroll,
  reconcileSelectedKey,
} from "../../widgets/index.js";
import type { Story } from "../types.js";
import { Button, Modal, Panel } from "./demo-atoms.js";

const PICKER_SELECT = [{ name: "select", displayName: "select", hotkey: "Enter" }] as const;

function pickerChoiceRows(n: number): Array<{
  name: string;
  actions: typeof PICKER_SELECT;
}> {
  const names = [
    "LM Studio",
    "Docker Model Runner",
    ...Array.from({ length: Math.max(0, n - 2) }, (_, i) => `choice-${String(i + 3).padStart(2, "0")}`),
  ].slice(0, n);
  return names.map((name) => ({ name, actions: PICKER_SELECT }));
}

export const WIDGET_STORIES: Story[] = [
  {
    id: "w-text",
    name: "Text",
    category: "widgets",
    family: "atoms",
    description: "Plain / bold / banned dim channel / nowrap ellipsis",
    build: (ctx) => ({
      type: "box",
      style: { width: ctx.cols, height: ctx.rows, padding: 1 },
      children: [
        Text("Plain text", { style: { role: "foreground" } }),
        Text("Bold label", { style: { bold: true, role: "accent" } }),
        // color-parity-ignore: literal fg+dim is the point of this line — it
        // demonstrates the banned SGR2 `dim` attribute itself (role-authored
        // styles can never reach it; the resolver only ever emits it).
        Text("Dim secondary", { style: { dim: true, fg: 244 } }),
        Text(`nowrap ellipsis: ${"word ".repeat(40)}`, {
          whiteSpace: "nowrap",
          ellipsis: true,
          style: { role: "foreground" },
        }),
      ],
    }),
  },
  {
    id: "w-button",
    name: "Button",
    category: "widgets",
    family: "atoms",
    description: "Bordered activate control",
    build: () =>
      Panel([Button("Primary", { key: "btn-primary" }), Text(" "), Button("Cancel", { key: "btn-cancel" })], {
        title: "Buttons",
        width: 36,
        height: 9,
      }),
  },
  {
    id: "w-panel",
    name: "Panel",
    category: "widgets",
    family: "atoms",
    description: "Bordered surface panel (bgRole surface · BgP.panel)",
    build: (ctx) =>
      Panel(
        [
          Text("Solid panel fill so borders sit on surface,", {
            style: { role: "foreground" },
          }),
          Text("not terminal ground (TERMINAL O1).", {
            style: { role: "foreground" },
          }),
        ],
        {
          title: "Panel",
          width: Math.min(48, ctx.cols),
          height: Math.min(10, ctx.rows),
        },
      ),
  },
  {
    id: "w-multiline",
    name: "ComposerFrame · drafts",
    category: "widgets",
    family: "chrome",
    description: "chrome_frame body wrap — drafts, not the product chrome",
    sampleCount: 4,
    build: (ctx) => {
      const samples = [
        { inputValue: "Type a message…", mark: null as number | null },
        { inputValue: "Multi-line draft\nwith a second line", mark: null },
        { inputValue: "Long ".repeat(20).trim(), mark: null },
        {
          inputValue: "select this phrase then keep wrapping on",
          mark: 0,
        },
      ];
      const pick = samples[ctx.sample % samples.length]!;
      return ComposerFrame(
        {
          inputValue: pick.inputValue,
          cursor: pick.inputValue.length,
          mark: pick.mark,
          hotkeys: [{ key: "Enter", action: "send" }],
          annotation: "idle",
          statusItems: ["act"],
          placeholder: "Type a message…",
        },
        { key: "composer:frame", width: Math.min(44, ctx.cols) },
      );
    },
  },
  {
    id: "w-markdown",
    name: "Markdown",
    category: "widgets",
    family: "priors",
    description: "Markdown() prior — constructor identity, not the token grammar",
    build: (ctx) =>
      Panel(
        [
          Markdown(
            [
              "# Heading",
              "",
              "Paragraph with `code` and **bold**.",
              "",
              "- list one",
              "- list two",
              "",
              "```",
              "fenced block",
              "```",
            ].join("\n"),
            { width: Math.min(40, ctx.cols - 4) },
          ),
        ],
        { title: "Markdown", width: Math.min(46, ctx.cols) },
      ),
  },
  {
    id: "w-modal",
    name: "Modal",
    category: "widgets",
    family: "atoms",
    description: "Engine stamps region-dim 0.4 on the room — no authored dim, identity stays",
    build: (ctx) => ({
      type: "box",
      style: { width: ctx.cols, height: ctx.rows, padding: 1 },
      children: [
        Text("accent still accent", { style: { role: "accent" } }),
        Text("error still error", { style: { role: "error" } }),
        Text("success still success", { style: { role: "success" } }),
        Text("code still code", { style: { role: "code" } }),
        Modal(Text("Confirm action?"), { title: "Modal", key: "m1" }),
      ],
    }),
  },
  {
    id: "w-thinking-collapsed",
    name: "Thinking · collapsed",
    category: "widgets",
    family: "thinking",
    description: "sealed + collapsed · ⁖ collapsed",
    build: () =>
      ThinkingStream(
        {
          text: "hidden chain of thought",
          live: false,
          collapsed: true,
          seal: "sealed",
          durationMs: 3400,
        },
        { key: "th-collapse" },
      ),
  },
  {
    id: "w-thinking-live",
    name: "Thinking · live expanded",
    category: "widgets",
    family: "thinking",
    description: "paint owns time — startedAt + nowMs resolve elapsed; TEA never sends braille",
    sampleCount: 3,
    build: (ctx) => {
      const now = ctx.nowMs ?? 1_700_000_000_000;
      const elapsed = [0, 3400, 62_000][ctx.sample % 3]!;
      return ThinkingStream(
        {
          text: "considering layout constraints",
          live: true,
          collapsed: false,
          seal: "live",
          startedAt: now - elapsed,
        },
        { key: "th-live", width: Math.min(36, ctx.cols - 2) },
      );
    },
  },
  {
    id: "w-thinking-sealed",
    name: "Thinking · sealed",
    category: "widgets",
    family: "thinking",
    description: "sealed + expanded · ⁖ header, dim ┃ markdown",
    build: (ctx) =>
      ThinkingStream(
        {
          text: "settled reasoning for the user",
          live: false,
          collapsed: false,
          seal: "sealed",
        },
        { key: "th-seal", width: Math.min(36, ctx.cols - 2) },
      ),
  },
  {
    id: "w-thinking-omitted",
    name: "Thinking · omitted",
    category: "widgets",
    family: "thinking",
    description: "sealed + empty body → omission copy (not a collapsed thought)",
    build: () =>
      ThinkingStream(
        {
          text: "",
          live: false,
          collapsed: true,
          seal: "sealed",
          agentLabel: "Claude",
          durationMs: 3200,
        },
        { key: "th-omit" },
      ),
  },
  {
    id: "w-speech-user",
    name: "Speech · user",
    category: "widgets",
    family: "speech",
    description: "user voice · ❯ inside a surface mist floor",
    build: (ctx) =>
      Speech(
        { text: "run the typecheck", voice: "user", atMs: Date.UTC(2023, 10, 14, 15, 4) },
        { key: "sp-user", width: Math.min(40, ctx.cols - 2) },
      ),
  },
  {
    id: "w-speech-live",
    name: "Speech · live assistant",
    category: "widgets",
    family: "speech",
    description: "live assistant · spinner gutter · same voice as the prompt",
    build: (ctx) =>
      Speech(
        { text: "checking the tape column", live: true, atMs: Date.UTC(2023, 10, 14, 15, 5) },
        { key: "sp-live", width: Math.min(40, ctx.cols - 2) },
      ),
  },
  {
    id: "w-speech-failed",
    name: "Speech · failed",
    category: "widgets",
    family: "speech",
    description: "failed assistant · error text · no spinner",
    build: (ctx) =>
      Speech({ text: "turn failed", failed: true }, { key: "sp-fail", width: Math.min(40, ctx.cols - 2) }),
  },
  {
    id: "w-composer-chrome",
    name: "ComposerFrame · chrome",
    category: "widgets",
    family: "chrome",
    description: "progress rail · hints fuse into the rule above the draft · T-join when stacked",
    sampleCount: 6,
    build: (ctx) => {
      const w = Math.min(44, ctx.cols);
      const labels = [
        "progress 0% · contour hue",
        "progress 35% · context",
        "progress 50% · warning hue (plugin ride)",
        "progress 100%",
        "error annotation",
        "T-join slash picker · hotkeys on ├┤",
      ];
      const samples = [
        {
          inputValue: "",
          cursor: 0,
          placeholder: "Type a message…",
          hotkeys: [{ key: "Enter", action: "send" }],
          progress: 0,
          statusItems: ["act"],
        },
        {
          inputValue: "keep going",
          cursor: 10,
          placeholder: "Type a message…",
          hotkeys: [{ key: "Enter", action: "send" }],
          annotation: "idle",
          progress: 0.35,
          statusItems: ["act"],
        },
        {
          inputValue: "keep going",
          cursor: 10,
          placeholder: "Type a message…",
          hotkeys: [{ key: "Enter", action: "send" }],
          annotation: "idle",
          progress: 0.5,
          progressColor: "warning",
          statusItems: ["act"],
        },
        {
          inputValue: "keep going",
          cursor: 10,
          placeholder: "Type a message…",
          hotkeys: [{ key: "Enter", action: "send" }],
          annotation: "idle",
          progress: 1,
          statusItems: ["act"],
        },
        {
          inputValue: "this will fail",
          cursor: 14,
          placeholder: "Type a message…",
          hotkeys: [{ key: "Enter", action: "send" }],
          errorAnnotation: {
            level: "error" as const,
            message: "provider refused the turn",
          },
          statusItems: ["act"],
        },
        {
          inputValue: "/con",
          cursor: 4,
          placeholder: "Type a message…",
          hotkeys: [{ key: "Tab", action: "accept" }],
          commandChoices: [
            {
              name: "connect",
              description: "attach a connection",
              actions: [{ name: "run", displayName: "Run" }],
            },
            {
              name: "config",
              description: "edit local config",
              actions: [{ name: "run", displayName: "Run" }],
            },
          ],
          selectedCommandIndex: 0,
          statusItems: ["act"],
        },
      ] as const;
      const model = samples[ctx.sample % samples.length]!;
      const label = labels[ctx.sample % labels.length]!;
      return {
        type: "box",
        children: [
          Text(label, {
            style: { role: "muted" },
            whiteSpace: "nowrap",
          }),
          ComposerFrame(model, { key: "composer:chrome", width: w }),
        ],
      };
    },
  },
  {
    id: "w-composer-picker-peek",
    name: "ComposerFrame · picker peek",
    category: "widgets",
    family: "chrome",
    description: "peek-scroll window: one row below/above unless first/last",
    sampleCount: 5,
    build: (ctx) => {
      const w = Math.min(48, ctx.cols);
      const choices = pickerChoiceRows(15);
      const labels = [
        "peek Down keeps one below",
        "peek Up keeps one above",
        "interior arrows no scroll",
        "first of list on first slot",
        "last of list on last slot",
      ];
      const samples = [
        { selectedCommandIndex: 7, scrollOffset: 1 },
        { selectedCommandIndex: 1, scrollOffset: 0 },
        { selectedCommandIndex: 3, scrollOffset: 0 },
        { selectedCommandIndex: 0 },
        { selectedCommandIndex: 14, scrollOffset: 7 },
      ];
      const model = samples[ctx.sample % samples.length]!;
      const label = labels[ctx.sample % labels.length]!;
      return {
        type: "box",
        children: [
          Text(label, { style: { role: "muted" }, whiteSpace: "nowrap" }),
          ComposerFrame(
            {
              inputValue: "/connect",
              cursor: 8,
              commandChoices: choices,
              selectedCommandIndex: model.selectedCommandIndex,
              scrollOffset: model.scrollOffset,
              statusItems: ["act"],
            },
            { key: "composer:peek", width: w },
          ),
        ],
      };
    },
  },
  {
    id: "w-composer-picker-thumb",
    name: "ComposerFrame · picker right-│",
    category: "widgets",
    family: "chrome",
    description: "right-│ coverage ramp — same glyph, prominence only",
    sampleCount: 3,
    build: (ctx) => {
      const w = Math.min(48, ctx.cols);
      const labels = ["N≤V uniform contour", "s=1 of 10 on 5-row track", "max scroll flush on last │"];
      const samples = [
        { commandChoices: pickerChoiceRows(5) },
        {
          commandChoices: pickerChoiceRows(15),
          pickerViewport: 5,
          scrollOffset: 1,
        },
        {
          commandChoices: pickerChoiceRows(100),
          pickerViewport: 8,
          scrollOffset: 92,
        },
      ];
      const model = samples[ctx.sample % samples.length]!;
      const label = labels[ctx.sample % labels.length]!;
      return {
        type: "box",
        children: [
          Text(label, { style: { role: "muted" }, whiteSpace: "nowrap" }),
          ComposerFrame(
            {
              inputValue: "/connect",
              cursor: 8,
              selectedCommandIndex: 0,
              statusItems: ["act"],
              ...model,
            },
            { key: "composer:thumb", width: w },
          ),
        ],
      };
    },
  },
  {
    id: "w-composer-picker-identity",
    name: "ComposerFrame · picker identity",
    category: "widgets",
    family: "chrome",
    description: "already-filtered rows keep selectedCommandKey",
    sampleCount: 2,
    build: (ctx) => {
      const w = Math.min(48, ctx.cols);
      const select = [{ name: "select", displayName: "select", hotkey: "Enter" }];
      const labels = ["filter keeps key", "vanished key → first remaining"];
      const filtered = [
        { name: "openrouter", actions: select },
        { name: "openai", actions: select },
      ];
      const remaining = [{ name: "chatgpt", actions: select }];
      const samples = [
        {
          commandChoices: filtered,
          selectedCommandKey: "choice:1:openai",
        },
        {
          commandChoices: remaining,
          selectedCommandKey: reconcileSelectedKey("choice:1:openai", remaining),
        },
      ];
      const model = samples[ctx.sample % samples.length]!;
      const label = labels[ctx.sample % labels.length]!;
      return {
        type: "box",
        children: [
          Text(label, { style: { role: "muted" }, whiteSpace: "nowrap" }),
          ComposerFrame(
            {
              inputValue: "/connect open",
              cursor: 13,
              statusItems: ["act"],
              ...model,
            },
            { key: "composer:identity", width: w },
          ),
        ],
      };
    },
  },
  {
    id: "w-composer-picker-pointer",
    name: "ComposerFrame · picker pointer",
    category: "widgets",
    family: "chrome",
    description: "hover half / press full / drag-off; › stays on selected",
    sampleCount: 5,
    build: (ctx) => {
      const w = Math.min(48, ctx.cols);
      const choices = pickerChoiceRows(15);
      const keyAt = (i: number) => `choice:${i}:${choices[i]!.name}`;
      const labels = ["hover half", "press full", "drag-off half", "drag-back full", "selected ∩ press-off"];
      const samples = [
        { pickerHoverKey: keyAt(2) },
        { pickerPressKey: keyAt(2), pickerHoverKey: keyAt(2) },
        { pickerPressKey: keyAt(2), pickerHoverKey: keyAt(4) },
        { pickerPressKey: keyAt(2), pickerHoverKey: keyAt(2) },
        { pickerPressKey: keyAt(0), pickerHoverKey: keyAt(2) },
      ];
      const model = samples[ctx.sample % samples.length]!;
      const label = labels[ctx.sample % labels.length]!;
      return {
        type: "box",
        children: [
          Text(label, { style: { role: "muted" }, whiteSpace: "nowrap" }),
          ComposerFrame(
            {
              inputValue: "/connect",
              cursor: 8,
              commandChoices: choices,
              selectedCommandIndex: 0,
              statusItems: ["act"],
              ...model,
            },
            { key: "composer:pointer", width: w },
          ),
        ],
      };
    },
  },
  {
    id: "w-composer-picker-wheel",
    name: "ComposerFrame · picker wheel",
    category: "widgets",
    family: "chrome",
    description: "wheel writes scrollOffset only; next focus write peeks",
    sampleCount: 2,
    build: (ctx) => {
      const w = Math.min(48, ctx.cols);
      const choices = pickerChoiceRows(15);
      const labels = ["wheel leaves focus offscreen", "focus write peeks again"];
      const samples = [
        { selectedCommandIndex: 0, scrollOffset: 5 },
        {
          selectedCommandIndex: 0,
          scrollOffset: peekScroll(0, 15, 8, 0),
        },
      ];
      const model = samples[ctx.sample % samples.length]!;
      const label = labels[ctx.sample % labels.length]!;
      return {
        type: "box",
        children: [
          Text(label, { style: { role: "muted" }, whiteSpace: "nowrap" }),
          ComposerFrame(
            {
              inputValue: "/connect",
              cursor: 8,
              commandChoices: choices,
              pickerViewport: 8,
              statusItems: ["act"],
              ...model,
            },
            { key: "composer:wheel", width: w },
          ),
        ],
      };
    },
  },
  {
    id: "w-composer-ui",
    name: "ComposerFrame · callback UI",
    category: "widgets",
    family: "chrome",
    description: "same contour: confirm / input / notice / open-url / dim wait",
    sampleCount: 5,
    build: (ctx) => {
      const w = Math.min(44, ctx.cols);
      const labels = [
        "confirm · no caret · dim contour",
        "input remainder · Base URL",
        "secret input · masked",
        "notice dismiss",
        "open-url continue",
      ];
      const samples = [
        {
          inputValue: "",
          interactive: false,
          placeholder: "Remove work?",
          commandAction: {
            name: "ui/resolve",
            displayName: "Confirm",
            actions: [{ name: "ui/resolve", displayName: "Cancel", hotkey: "escape" }],
          },
          commandChoices: [] as const,
          hotkeys: [{ key: "Esc", action: "cancel" }],
        },
        {
          inputValue: "http://127.0.0.1:1234/v1",
          cursor: 26,
          interactive: true,
          placeholder: "OpenAI-compatible endpoint",
          commandAction: {
            name: "ui/resolve",
            displayName: "Base URL",
            actions: [{ name: "ui/resolve", displayName: "Cancel", hotkey: "escape" }],
          },
          commandChoices: [] as const,
          hotkeys: [{ key: "Esc", action: "cancel" }],
        },
        {
          inputValue: "••••••••",
          cursor: 8,
          interactive: true,
          placeholder: "API token",
          commandAction: {
            name: "ui/resolve",
            displayName: "Token",
            actions: [{ name: "ui/resolve", displayName: "Cancel", hotkey: "escape" }],
          },
          commandChoices: [] as const,
          hotkeys: [{ key: "Esc", action: "cancel" }],
        },
        {
          inputValue: "",
          interactive: false,
          placeholder: "Removed work.",
          commandAction: {
            name: "ui/resolve",
            displayName: "Dismiss",
            actions: [],
          },
          commandChoices: [] as const,
        },
        {
          inputValue: "",
          interactive: false,
          placeholder: "https://auth.example/device",
          commandAction: {
            name: "ui/resolve",
            displayName: "Continue",
            actions: [{ name: "ui/resolve", displayName: "Cancel", hotkey: "escape" }],
          },
          commandChoices: [] as const,
          hotkeys: [{ key: "Esc", action: "cancel" }],
        },
      ] as const;
      const model = samples[ctx.sample % samples.length]!;
      const label = labels[ctx.sample % labels.length]!;
      return {
        type: "box",
        children: [
          Text(label, {
            style: { role: "muted" },
            whiteSpace: "nowrap",
          }),
          ComposerFrame(model, { key: "composer:callback", width: w }),
        ],
      };
    },
  },
];
