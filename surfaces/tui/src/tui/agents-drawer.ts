/**
 * Agents drawer replica projection. Compact meter is a 0/1 composer-adjacent row.
 * Drawer body is the overlay list — not a nested tape.
 */
import { flattenAgentDrawer, projectAgentDrawer, projectAgentMeter, type Client } from "@inhuman.tools/harness-sdk";
import { titleAgentSpec } from "@inhuman.tools/harness-sdk/text";

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

export function agentsPreviewTitle(face: Pick<AgentsReplicaFace, "previewKey" | "rows">): string {
  if (face.previewKey === "") return "";
  return face.rows.find((row) => row.key === face.previewKey)?.name ?? "";
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
