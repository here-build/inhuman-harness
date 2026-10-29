import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { type ToolBody, type ToolOutcome } from "../../../harness-web-app/src/shell/tool-receipt.js";
import { lineDiff } from "../line-diff.js";
import { plainTerminal } from "../terminal-text.js";
import { ink, T } from "./host.js";
import { Markdown } from "./markdown.js";

/** A block taller than this many lines folds to its head with a way to open the rest. */
const FOLD_LINES = 12;

export function OutcomeMark({ outcome }: { readonly outcome: ToolOutcome }) {
  if (outcome === "ok") return null;
  if (outcome === "live") return <ActivityIndicator size="small" accessibilityLabel="In progress" />;
  return (
    <T role="footnote" color={ink.red}>
      failed
    </T>
  );
}

/** Monospaced text in a rounded well: wide lines scroll sideways, long text folds. */
export function MonoBlock({
  text,
  head,
  tone = ink.label,
}: {
  readonly text: string;
  readonly head?: string;
  readonly tone?: string | typeof ink.label;
}) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const folded = !open && lines.length > FOLD_LINES;
  const shown = folded ? lines.slice(0, FOLD_LINES).join("\n") : text;
  const hidden = lines.length - FOLD_LINES;
  return (
    <View style={{ backgroundColor: ink.fill, borderRadius: 10, borderCurve: "continuous", overflow: "hidden" }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12 }}>
        <View>
          {head == null ? null : (
            <T role="subhead" mono color={ink.secondary} style={{ marginBottom: shown === "" ? 0 : 6 }}>
              {head}
            </T>
          )}
          {shown === "" ? null : (
            <T role="subhead" mono color={tone}>
              {shown}
            </T>
          )}
        </View>
      </ScrollView>
      {lines.length <= FOLD_LINES ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={folded ? `Show ${hidden} more lines` : "Show less"}
          onPress={() => setOpen(!folded)}
          style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: ink.separator }}
        >
          <T role="footnote" color={ink.blue}>
            {folded ? `Show ${hidden} more lines` : "Show less"}
          </T>
        </Pressable>
      )}
    </View>
  );
}

export function DiffBlock({ body }: { readonly body: Extract<ToolBody, { kind: "diff" }> }) {
  const rows = useMemo(() => lineDiff(body.oldText, body.newText, body.lineStart), [body]);
  const [open, setOpen] = useState(false);
  const folded = !open && rows.length > FOLD_LINES * 2;
  const shown = folded ? rows.slice(0, FOLD_LINES * 2) : rows;
  const widest = rows.reduce((most, row) => {
    const no = row.kind === "gap" ? 0 : Math.max(row.oldNo ?? 0, row.newNo ?? 0);
    return Math.max(most, String(no).length);
  }, 1);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ backgroundColor: ink.fill, borderRadius: 10, borderCurve: "continuous", overflow: "hidden" }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ minWidth: "100%" }}>
            {shown.map((row, index) =>
              row.kind === "gap" ? (
                <View
                  key={index}
                  style={{ paddingHorizontal: 10, paddingVertical: 3, backgroundColor: ink.fillStrong }}
                >
                  <T role="footnote" mono color={ink.secondary}>
                    {`⋯ ${row.hidden} unchanged lines`}
                  </T>
                </View>
              ) : (
                <View
                  key={index}
                  style={{
                    flexDirection: "row",
                    paddingHorizontal: 10,
                    backgroundColor: row.kind === "add" ? ink.addFill : row.kind === "del" ? ink.delFill : undefined,
                  }}
                >
                  <T role="subhead" mono color={ink.tertiary} style={{ minWidth: widest * 9 + 4, textAlign: "right" }}>
                    {String(row.kind === "del" ? row.oldNo : row.newNo)}
                  </T>
                  <T
                    role="subhead"
                    mono
                    color={row.kind === "add" ? ink.green : row.kind === "del" ? ink.red : ink.tertiary}
                    style={{ width: 18, textAlign: "center" }}
                  >
                    {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
                  </T>
                  <T role="subhead" mono>
                    {row.text === "" ? " " : row.text}
                  </T>
                </View>
              ),
            )}
          </View>
        </ScrollView>
        {rows.length <= FOLD_LINES * 2 ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(!folded)}
            style={{ paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: ink.separator }}
          >
            <T role="footnote" color={ink.blue}>
              {folded ? `Show ${rows.length - FOLD_LINES * 2} more lines` : "Show less"}
            </T>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function ToolBodyView({ body, outcome = "ok" }: { readonly body: ToolBody; readonly outcome?: ToolOutcome }) {
  switch (body.kind) {
    case "empty":
      return (
        <T role="subhead" color={ink.secondary}>
          No result yet.
        </T>
      );
    case "text":
      return <MonoBlock text={body.text} />;
    case "code":
      return <MonoBlock text={body.text} />;
    case "markdown":
      return <Markdown text={body.text} />;
    case "diff":
      return (
        <View style={{ gap: 6 }}>
          <DiffBlock body={body} />
          {outcome === "ok" ? null : <OutcomeMark outcome={outcome} />}
        </View>
      );
    case "shell": {
      const output = plainTerminal(body.output).replace(/\n+$/, "");
      const status = body.exitCode == null || body.exitCode === 0 ? "" : `exit ${body.exitCode}`;
      return (
        <View style={{ gap: 6 }}>
          <MonoBlock
            head={`$ ${body.command}${body.directory == null || body.directory === "" ? "" : `   (${body.directory})`}`}
            text={output}
          />
          {status === "" && outcome === "ok" ? null : (
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              {status === "" ? null : (
                <T role="footnote" color={ink.red}>
                  {status}
                </T>
              )}
              <OutcomeMark outcome={outcome} />
            </View>
          )}
        </View>
      );
    }
    case "fail-line":
      return (
        <T role="subhead" color={ink.secondary}>
          {`Failed to ${body.verb}${body.label === "" ? "" : ` ${body.label}`}. ${body.detail}`}
        </T>
      );
    case "parts":
      return (
        <View style={{ gap: 8 }}>
          {body.parts.map((part, index) =>
            part.kind === "markdown" ? (
              <Markdown key={index} text={part.text} />
            ) : (
              <MonoBlock key={index} text={part.text} />
            ),
          )}
        </View>
      );
  }
}
