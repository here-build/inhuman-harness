import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import { ActivityIndicator, Image, Pressable, View } from "react-native";

import { OutcomeMark, ToolBodyView } from "./bodies.js";
import { ink, T, useDial, useHost } from "./host.js";
import { Markdown } from "./markdown.js";
import { naturalName } from "../../../harness-web-app/src/shell/model-choice.js";
import { readStoredVisual } from "../../../harness-web-app/src/shell/picture-draft.js";
import { fileFace } from "../../../harness-web-app/src/shell/read-line.js";
import {
  type AgentCell,
  type LookItem,
  type TapeBodyCell,
  agentFace,
  userPictureLine,
} from "../../../harness-web-app/src/shell/tape-read.js";
import { toolLabel } from "../../../harness-web-app/src/shell/tool-label.js";
import { lookParts, LOOK_VERB, lookSentences, glanceOf } from "../session-beats.js";

export const SIDE = 20;

type UserVisual = NonNullable<Extract<TapeBodyCell, { kind: "user" }>["visuals"]>[number];

/** Bytes come from `turn/visual`; the identity line never becomes a remote fetch. */
const Picture = observer(function PictureView({
  visual,
  index,
}: {
  readonly visual: UserVisual;
  readonly index: number;
}) {
  const dial = useDial();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const rpc = dial.sessionRpc;
  useEffect(() => {
    if (rpc == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const read = readStoredVisual(await rpc.request("turn/visual", { id: visual.id }));
        if (cancelled) return;
        if (read?.id !== visual.id) setFailed(true);
        else setUri(`data:${read.mime};base64,${read.bytesBase64}`);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, visual.id]);
  const width = Math.min(240, visual.width);
  const height = Math.round((width * visual.height) / visual.width);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={userPictureLine(index, visual)}
      style={{
        width,
        height: failed ? undefined : height,
        borderRadius: 14,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: ink.fill,
        alignItems: "center",
        justifyContent: "center",
        padding: failed ? 12 : 0,
      }}
    >
      {uri != null ? (
        <Image source={{ uri }} style={{ width, height }} resizeMode="cover" />
      ) : failed ? (
        <T role="footnote" color={ink.secondary}>
          The picture could not be loaded.
        </T>
      ) : (
        <ActivityIndicator />
      )}
    </View>
  );
});

export function UserCell({
  cell,
  onEdit,
}: {
  readonly cell: Extract<TapeBodyCell, { kind: "user" }>;
  readonly onEdit?: () => void;
}) {
  const host = useHost();
  const visuals = cell.visuals ?? [];
  const actions = [
    { id: "copy", title: "Copy" },
    ...(onEdit == null ? [] : [{ id: "edit", title: "Edit", subtitle: "Removes later messages", destructive: true }]),
  ];
  const run = (id: string): void => {
    if (id === "copy") host.copy(cell.text);
    else if (id === "edit") onEdit?.();
  };
  return (
    <View style={{ paddingLeft: SIDE, paddingRight: 16, alignItems: "flex-end", gap: 6 }}>
      {visuals.map((visual, index) => (
        <Picture key={visual.id} visual={visual} index={index} />
      ))}
      {cell.text === "" ? null : (
        <host.Menu actions={actions} onAction={run} style={{ maxWidth: "82%" }}>
          <View
            accessible
            accessibilityLabel={`You: ${cell.text}`}
            accessibilityActions={actions.map((action) => ({ name: action.id, label: action.title }))}
            onAccessibilityAction={(event) => run(event.nativeEvent.actionName)}
            style={{
              backgroundColor: ink.blue,
              borderRadius: 20,
              borderCurve: "continuous",
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            <T color="#FFFFFF">{cell.text}</T>
          </View>
        </host.Menu>
      )}
    </View>
  );
}

export function SpeechCell({ cell }: { readonly cell: Extract<TapeBodyCell, { kind: "speech" }> }) {
  const host = useHost();
  if (cell.text === "") return null;
  const actions = [{ id: "copy", title: "Copy" }];
  const run = (id: string): void => {
    if (id === "copy") host.copy(cell.text);
  };
  return (
    <host.Menu actions={actions} onAction={run}>
      <View
        style={{ paddingHorizontal: SIDE }}
        accessible
        accessibilityLabel={`Assistant: ${cell.text}`}
        accessibilityActions={[{ name: "copy", label: "Copy" }]}
        onAccessibilityAction={(event) => run(event.nativeEvent.actionName)}
      >
        <Markdown text={cell.text} />
      </View>
    </host.Menu>
  );
}

function LookSentence({ items }: { readonly items: readonly LookItem[] }) {
  const parts = lookParts(items.map((item) => item.label));
  let at = -1;
  const scope = items[0]?.scope;
  return (
    <T role="subhead" color={ink.secondary}>
      {`${LOOK_VERB[items[0]!.verb]} `}
      {parts.map((part, index) => {
        if (part.kind === "text") return part.text;
        at += 1;
        const item = items.at(at);
        if (item == null) return null;
        const failed = item.outcome === "failed";
        const binary = item.verb === "read" && fileFace(item.path) === "binary";
        return (
          <T key={index} role="subhead" mono color={failed ? ink.red : binary ? ink.tertiary : ink.label}>
            {item.label}
          </T>
        );
      })}
      {scope == null || scope === "" ? "" : " in "}
      {scope == null || scope === "" ? null : (
        <T role="subhead" mono color={ink.label}>
          {scope}
        </T>
      )}
      {items.some((item) => item.outcome === "failed") ? " — failed" : ""}
    </T>
  );
}

export function ReadsCell({ cell }: { readonly cell: Extract<TapeBodyCell, { kind: "reads" }> }) {
  const sentences = lookSentences(cell.items);
  const label = sentences
    .map((items) => `${LOOK_VERB[items[0]!.verb]} ${items.map((item) => item.label).join(", ")}`)
    .join(". ");
  return (
    <View accessible accessibilityLabel={label} style={{ paddingHorizontal: SIDE, gap: 3 }}>
      {sentences.map((items) => (
        <LookSentence key={items[0]!.id} items={items} />
      ))}
    </View>
  );
}

function Chevron({ open }: { readonly open: boolean }) {
  return (
    <T
      role="headline"
      color={ink.tertiary}
      style={{ width: 14, textAlign: "center", transform: [{ rotate: open ? "90deg" : "0deg" }] }}
    >
      ›
    </T>
  );
}

/** A tap opens it; the row says what it holds. */
export function Disclosure({
  title,
  trailing,
  label,
  children,
}: {
  readonly title: React.ReactNode;
  readonly trailing?: React.ReactNode;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ paddingHorizontal: SIDE, gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28 }}
      >
        <Chevron open={open} />
        <View style={{ flexShrink: 1 }}>{title}</View>
        {trailing}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

function ToolTitle({ summary }: { readonly summary: string }) {
  const gap = summary.indexOf(" ");
  const name = gap === -1 ? summary : summary.slice(0, gap);
  const object = gap === -1 ? "" : summary.slice(gap + 1);
  return (
    <T role="subhead" color={ink.secondary} numberOfLines={2}>
      {toolLabel(name)}
      {object === "" ? null : (
        <>
          {" "}
          <T role="subhead" mono color={ink.secondary}>
            {object}
          </T>
        </>
      )}
    </T>
  );
}

export function ToolCellView({ cell }: { readonly cell: Extract<TapeBodyCell, { kind: "tool" }> }) {
  const direct = cell.body.kind === "diff" || cell.body.kind === "shell" || cell.body.kind === "fail-line";
  if (direct) {
    return (
      <View style={{ paddingHorizontal: SIDE, gap: 6 }} accessible={false}>
        {cell.body.kind === "fail-line" ? null : <ToolTitle summary={cell.summary} />}
        <ToolBodyView body={cell.body} outcome={cell.outcome} />
      </View>
    );
  }
  const nested = (cell.nested ?? []).filter(
    (inner): inner is TapeBodyCell =>
      inner.kind !== "round" && inner.kind !== "progress" && inner.kind !== "agent" && inner.kind !== "settle",
  );
  return (
    <Disclosure
      label={`${toolLabel(cell.summary.split(" ")[0] ?? "")} ${cell.summary.split(" ").slice(1).join(" ")}${cell.outcome === "failed" ? ", failed" : ""}`}
      title={<ToolTitle summary={cell.summary} />}
      trailing={<OutcomeMark outcome={cell.outcome} />}
    >
      <View style={{ gap: 10 }}>
        <ToolBodyView body={cell.body} outcome={cell.outcome} />
        {nested.map((inner) => (
          <View key={inner.id} style={{ marginHorizontal: -SIDE }}>
            <Cell cell={inner} />
          </View>
        ))}
      </View>
    </Disclosure>
  );
}

/** Everything but the user's own message, which the list gives its edit hook. */
export function Cell({ cell, onEdit }: { readonly cell: TapeBodyCell; readonly onEdit?: () => void }) {
  if (cell.kind === "user") return <UserCell cell={cell} {...(onEdit == null ? {} : { onEdit })} />;
  if (cell.kind === "speech") return <SpeechCell cell={cell} />;
  if (cell.kind === "reads") return <ReadsCell cell={cell} />;
  return <ToolCellView cell={cell} />;
}

export const AgentRow = observer(function AgentRowView({ cell }: { readonly cell: AgentCell }) {
  const dial = useDial();
  const face = agentFace(cell, glanceOf(dial, cell.sessionId));
  const label = [face.name, face.model === "" ? "" : naturalName(face.model), face.task, face.status]
    .filter((part) => part !== "")
    .join(", ");
  return (
    <View
      accessible
      accessibilityLabel={`Agent ${label}`}
      style={{
        marginHorizontal: SIDE,
        padding: 12,
        gap: 3,
        backgroundColor: ink.fill,
        borderRadius: 12,
        borderCurve: "continuous",
      }}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <T role="subhead" style={{ fontWeight: "600" }}>
          {face.name}
        </T>
        {face.model === "" ? null : (
          <T role="footnote" mono color={ink.secondary}>
            {naturalName(face.model)}
          </T>
        )}
        {face.state === "live" ? <ActivityIndicator size="small" /> : null}
      </View>
      <T role="subhead" color={ink.secondary} numberOfLines={3}>
        {face.task}
      </T>
      {face.status === "" ? null : (
        <T role="footnote" color={face.state === "failed" ? ink.red : ink.secondary}>
          {face.status}
        </T>
      )}
    </View>
  );
});

export function ThoughtsRow({
  thoughts,
}: {
  readonly thoughts: readonly { readonly id: string; readonly text: string }[];
}) {
  return (
    <Disclosure
      label="Reasoning"
      title={
        <T role="subhead" color={ink.secondary}>
          Reasoning
        </T>
      }
    >
      <View style={{ gap: 10 }}>
        {thoughts.map((thought) => (
          <Markdown key={thought.id} text={thought.text} tone={ink.secondary} />
        ))}
      </View>
    </Disclosure>
  );
}
