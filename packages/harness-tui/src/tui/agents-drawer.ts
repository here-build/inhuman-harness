/**
 * Agents drawer paint. Compact meter is a 0/1 composer-adjacent row.
 * Drawer body is the overlay list — not a nested tape.
 */
import {
  flattenAgentDrawer,
  projectAgentDrawer,
  projectAgentMeter,
  SESSION_FACE_ASK,
  type Client,
} from "@inhuman.tools/harness-sdk";
import { titleAgentSpec } from "@inhuman.tools/harness-sdk/text";
import { INDICATION_VOID_GLYPH, type LayoutNode } from "@inhuman.tools/quickdraw/layout";
import { BgP, FgP } from "@inhuman.tools/quickdraw/lexicon";
import {
  AGENTS_PEEK_MAX_HEIGHT,
  APP_AGENTS_PEEK_KEY,
  STATUSLINE_PAD_L,
  STATUSLINE_PAD_R,
} from "@inhuman.tools/quickdraw/runtime";
import { Indication, Text } from "@inhuman.tools/quickdraw/widgets";

const LOUD = { role: "foreground" as const, prominence: FgP.rising };
const FOCUS = { role: "foreground" as const, prominence: FgP.primary };
const DIM = { role: "foreground" as const, prominence: FgP.ghost };
/** Same hue as the omnibox `always approve` chip. */
const ASK = { role: "attention" as const, prominence: FgP.secondary };

export type AgentsReplicaRow = {
  readonly key: string;
  readonly kind: "call" | "bot" | "session";
  readonly name: string;
  readonly recap: string;
  readonly indent: number;
  readonly prompt: string;
  readonly notifies: readonly string[];
  readonly result: string;
  readonly mark: string;
  readonly model: string;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly unfinished: string;
  readonly current: boolean;
  readonly sessionId: string;
};

export type AgentsReplicaFace = {
  readonly meterLeft: string;
  readonly meterRight: string;
  readonly open: boolean;
  readonly focusKey: string;
  readonly scroll: number;
  readonly rows: readonly AgentsReplicaRow[];
  /** Call key whose sneak-peek modal is open. Empty hides the modal. */
  readonly previewKey: string;
};

export type AgentsDrawerChrome = {
  readonly open: boolean;
  readonly focusKey: string | null;
  readonly scroll: number;
  readonly previewKey?: string | null;
};

export function agentsPaintFace(client: Client, chrome: AgentsDrawerChrome): AgentsReplicaFace | null {
  const drawer = projectAgentDrawer(client);
  const meter = projectAgentMeter(client, drawer);
  const rows = flattenAgentDrawer(drawer).map((row): AgentsReplicaRow => {
    const spec = typeof row.spec === "string" ? row.spec : "";
    return {
      key: row.key,
      kind: row.kind,
      name: row.kind === "session" ? spec : displayName(spec),
      recap: row.recap,
      indent: row.indent,
      prompt: row.prompt,
      notifies: row.notifies,
      result: row.result,
      mark: row.mark,
      model: row.model ?? "",
      lastPrompt: row.lastPrompt ?? "",
      askLine: row.askLine ?? "",
      unfinished: row.unfinished ?? "",
      current: row.current === true,
      sessionId: row.sessionId ?? "",
    };
  });
  const previewKey = chrome.previewKey ?? "";
  if (meter == null && !chrome.open && previewKey === "") return null;
  return {
    meterLeft: meter == null ? "" : meterLeft(meter.calls),
    meterRight:
      meter == null
        ? ""
        : meter.bots
            .map(displayName)
            .filter((name) => name !== "")
            .join(", "),
    open: chrome.open,
    focusKey: chrome.focusKey ?? "",
    scroll: chrome.scroll,
    rows,
    previewKey,
  };
}

/** Left of the top overview row. The arrow is the empty-prompt chord, not a name. */
export const AGENTS_OVERVIEW_LABEL = "←: overview";

export function prepareAgentsMeter(calls: string, bots: string, width: number): LayoutNode {
  const names = [calls, bots].filter((part) => part !== "").join(", ");
  const children: LayoutNode[] = [
    Text(AGENTS_OVERVIEW_LABEL, {
      key: "agents:meter:label",
      whiteSpace: "nowrap",
      style: { role: "foreground", prominence: FgP.secondary },
    }),
    {
      type: "box",
      key: "agents:meter:gap",
      style: { flex: 1 },
      children: [],
    },
  ];
  if (names !== "") {
    children.push(
      Text(names, {
        key: "agents:meter:names",
        whiteSpace: "nowrap",
        ellipsis: true,
        style: { role: "foreground", prominence: FgP.rising },
      }),
    );
  }
  return {
    type: "flex",
    key: "agents:meter:line",
    style: {
      direction: "row",
      width,
      height: 1,
      gap: 1,
      padding: { l: STATUSLINE_PAD_L, r: STATUSLINE_PAD_R },
    },
    children,
  };
}

export function prepareAgentsDrawer(face: AgentsReplicaFace, width: number): LayoutNode {
  const children: LayoutNode[] = [];
  const calls = face.rows.filter((row) => row.kind === "call");
  const bots = face.rows.filter((row) => row.kind === "bot");
  const sessions = face.rows.filter((row) => row.kind === "session");
  if (calls.length > 0) {
    children.push(bandHeader("agents:subagents", "Subagents", width));
    for (const row of calls) children.push(rowNode(row, face, width));
  }
  if (bots.length > 0) {
    children.push(bandHeader("agents:bots", "Collaborators", width));
    for (const row of bots) children.push(rowNode(row, face, width));
  }
  if (sessions.length > 0) {
    children.push(bandHeader("agents:sessions", "Sessions", width));
    for (const row of sessions) children.push(rowNode(row, face, width));
  }
  return { type: "box", key: "agents:body", style: { width }, children };
}

const PANEL_FILL = { bgRole: "surface" as const, bgProminence: BgP.panel };

export function agentsPreviewTitle(face: Pick<AgentsReplicaFace, "previewKey" | "rows">): string {
  if (face.previewKey === "") return "";
  return face.rows.find((row) => row.key === face.previewKey)?.name ?? "";
}

export function prepareAgentsPeek(face: AgentsReplicaFace): LayoutNode | null {
  if (!face.open || face.focusKey === "" || face.previewKey !== "") return null;
  const row = face.rows.find((item) => item.key === face.focusKey);
  if (row === undefined || row.kind === "bot") return null;
  if (row.kind === "session" && row.current) return null;
  const children: LayoutNode[] = [];
  const push = (node: LayoutNode): void => {
    children.push(node);
  };
  if (row.recap !== "") {
    push(
      Text(row.recap, {
        key: `${APP_AGENTS_PEEK_KEY}:status`,
        whiteSpace: "normal",
        ellipsis: true,
        lineClamp: row.kind === "call" ? 3 : 5,
        style: LOUD,
      }),
    );
  }
  if (row.kind === "call" && (row.unfinished === "ask" || row.unfinished === "question") && row.askLine !== "") {
    push(
      Text(row.askLine, {
        key: `${APP_AGENTS_PEEK_KEY}:ask`,
        whiteSpace: "nowrap",
        ellipsis: true,
        style: ASK,
      }),
    );
  }
  const notify = row.kind === "call" ? (row.notifies.find((line) => line.trim() !== "") ?? "") : "";
  if (notify !== "") {
    push(
      Text(notify, {
        key: `${APP_AGENTS_PEEK_KEY}:notify`,
        whiteSpace: "normal",
        ellipsis: true,
        lineClamp: 2,
        style: DIM,
      }),
    );
  }
  if (row.kind === "call" && row.result !== "") {
    push(
      Text(row.result, {
        key: `${APP_AGENTS_PEEK_KEY}:result`,
        whiteSpace: "normal",
        ellipsis: true,
        lineClamp: 3,
        style: LOUD,
      }),
    );
  }
  if (row.model !== "") {
    if (children.length > 0) {
      push({
        type: "box",
        key: `${APP_AGENTS_PEEK_KEY}:gap`,
        style: { height: 1 },
        children: [],
      });
    }
    push(
      Text(row.model, {
        key: `${APP_AGENTS_PEEK_KEY}:model`,
        whiteSpace: "nowrap",
        ellipsis: true,
        style: DIM,
      }),
    );
  }
  if (children.length === 0) return null;
  return {
    type: "box",
    key: APP_AGENTS_PEEK_KEY,
    userSelect: "none",
    style: {
      padding: 1,
      maxHeight: AGENTS_PEEK_MAX_HEIGHT,
      overflow: "hidden",
      background: PANEL_FILL,
    },
    children,
  };
}

function meterLeft(groups: readonly { readonly spec: string; readonly count: number }[]): string {
  if (groups.length === 0) return "";
  return groups
    .map((group) => {
      const name = displayName(group.spec);
      return group.count > 1 ? `${String(group.count)}× ${name}` : name;
    })
    .join(", ");
}

function displayName(spec: string): string {
  const titled = titleAgentSpec(spec);
  return titled === "" ? spec : titled;
}

function bandHeader(key: string, label: string, _width: number): LayoutNode {
  return Text(label, {
    key,
    whiteSpace: "nowrap",
    style: DIM,
  });
}

function rowNode(row: AgentsReplicaRow, face: AgentsReplicaFace, width: number): LayoutNode {
  const focused = row.key === face.focusKey;
  const indent = row.indent > 0 ? Math.min(row.indent, 6) : 0;
  const pad = indent * 2;
  const allocW = Math.max(8, width - pad);
  const body: LayoutNode[] =
    row.kind === "bot" ? [identityLine(row, focused, allocW)] : [sessionLine(row, focused, allocW)];
  const block: LayoutNode = {
    type: "box",
    key: row.key,
    ...(row.kind === "session" || row.kind === "call"
      ? { intent: "activate" as const, userSelect: "none" as const }
      : {}),
    style: { width: allocW },
    children: [
      Indication({
        key: `${row.key}:id`,
        gutter: { kind: "top", glyph: INDICATION_VOID_GLYPH },
        children: body,
      }),
    ],
  };
  if (indent === 0) return block;
  return {
    type: "box",
    key: `${row.key}:indent`,
    style: { padding: { l: pad }, width },
    children: [block],
  };
}

function sessionLine(row: AgentsReplicaRow, focused: boolean, width: number): LayoutNode {
  const children: LayoutNode[] = [
    {
      type: "box",
      key: `${row.key}:title`,
      style: { flex: 1, height: 1 },
      children: [
        Text(row.name, {
          key: `${row.key}:name`,
          whiteSpace: "nowrap",
          ellipsis: true,
          style: focused ? FOCUS : LOUD,
        }),
      ],
    },
  ];
  if (row.mark !== "") {
    children.push(
      Text(row.mark, {
        key: `${row.key}:mark`,
        whiteSpace: "nowrap",
        style: row.mark === SESSION_FACE_ASK ? ASK : DIM,
      }),
    );
  }
  return {
    type: "box",
    key: `${row.key}:id-line`,
    style: { width, height: 1 },
    children: [
      {
        type: "flex",
        key: `${row.key}:id-row`,
        style: { direction: "row", height: 1, gap: 1 },
        children,
      },
    ],
  };
}

function identityLine(row: AgentsReplicaRow, focused: boolean, width: number): LayoutNode {
  const name = Text(row.recap === "" ? row.name : `${row.name} `, {
    key: `${row.key}:name`,
    whiteSpace: "nowrap",
    style: focused ? FOCUS : LOUD,
  });
  if (row.recap === "") return name;
  return {
    type: "flex",
    key: `${row.key}:id-line`,
    style: { direction: "row", width },
    children: [
      name,
      Text(row.recap, {
        key: `${row.key}:recap`,
        whiteSpace: "nowrap",
        ellipsis: true,
        lineClamp: 1,
        style: DIM,
      }),
    ],
  };
}
