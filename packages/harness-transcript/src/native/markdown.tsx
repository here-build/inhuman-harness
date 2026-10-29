import { memo, type ReactNode } from "react";
import { ScrollView, View, type TextStyle } from "react-native";

import { type Block, type Inline, markdownBlocks } from "../markdown-tree.js";
import { ink, T, useHost } from "./host.js";

const HEADING: Readonly<Record<number, number>> = { 1: 8, 2: 5, 3: 2, 4: 0, 5: 0, 6: 0 };

function Inlines({
  nodes,
  link,
  code,
}: {
  readonly nodes: readonly Inline[];
  readonly link: (url: string) => void;
  readonly code: TextStyle["color"];
}): ReactNode {
  return nodes.map((node, index) => {
    switch (node.t) {
      case "text":
        return node.v;
      case "br":
        return "\n";
      case "code":
        return (
          <T key={index} role="subhead" mono color={code} style={{ backgroundColor: ink.fill }}>
            {node.v}
          </T>
        );
      case "strong":
        return (
          <T key={index} style={{ fontWeight: "700" }} color={code}>
            <Inlines nodes={node.c} link={link} code={code} />
          </T>
        );
      case "em":
        return (
          <T key={index} style={{ fontStyle: "italic" }} color={code}>
            <Inlines nodes={node.c} link={link} code={code} />
          </T>
        );
      case "del":
        return (
          <T key={index} style={{ textDecorationLine: "line-through" }} color={code}>
            <Inlines nodes={node.c} link={link} code={code} />
          </T>
        );
      case "link":
        return (
          <T key={index} color={ink.blue} accessibilityRole="link" onPress={() => link(node.url)}>
            <Inlines nodes={node.c} link={link} code={ink.blue} />
          </T>
        );
      case "image":
        return (
          <T key={index} color={ink.blue} accessibilityRole="link" onPress={() => link(node.url)}>
            {node.alt === "" ? node.url : node.alt}
          </T>
        );
    }
  });
}

function Code({ text }: { readonly text: string }) {
  return (
    <View style={{ backgroundColor: ink.fill, borderRadius: 10, borderCurve: "continuous", overflow: "hidden" }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12 }}>
        <T role="subhead" mono>
          {text}
        </T>
      </ScrollView>
    </View>
  );
}

function Table({ block, tone }: { readonly block: Extract<Block, { t: "table" }>; readonly tone: TextStyle["color"] }) {
  const host = useHost();
  const columns = block.head.length;
  const line = (cells: readonly (readonly Inline[])[], head: boolean, last: boolean) => (
    <View
      style={{
        flexDirection: "row",
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: ink.separator,
        backgroundColor: head ? ink.fill : undefined,
      }}
    >
      {Array.from({ length: columns }, (_, column) => (
        <View key={column} style={{ width: 132, paddingHorizontal: 10, paddingVertical: 7 }}>
          <T
            role="subhead"
            color={tone}
            style={{ fontWeight: head ? "600" : "400", textAlign: block.align[column] ?? "left" }}
          >
            <Inlines nodes={cells[column] ?? []} link={host.openUrl} code={tone} />
          </T>
        </View>
      ))}
    </View>
  );
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: ink.separator,
        borderRadius: 10,
        borderCurve: "continuous",
        overflow: "hidden",
      }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {line(block.head, true, false)}
          {block.rows.map((row, index) => (
            <View key={index}>{line(row, false, index === block.rows.length - 1)}</View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function Blocks({
  blocks,
  tone,
  depth,
}: {
  readonly blocks: readonly Block[];
  readonly tone: TextStyle["color"];
  readonly depth: number;
}) {
  const host = useHost();
  return (
    <View style={{ gap: depth === 0 ? 12 : 6 }}>
      {blocks.map((block, index) => {
        switch (block.t) {
          case "p":
            return (
              <T key={index} color={tone}>
                <Inlines nodes={block.c} link={host.openUrl} code={tone} />
              </T>
            );
          case "h":
            return (
              <T
                key={index}
                role="headline"
                color={tone}
                accessibilityRole={undefined}
                style={{
                  fontWeight: "700",
                  fontSize: host.faces.headline.fontSize + (HEADING[block.level] ?? 0),
                  lineHeight: host.faces.headline.lineHeight + (HEADING[block.level] ?? 0),
                  marginTop: depth === 0 && index > 0 ? 6 : 0,
                }}
              >
                <Inlines nodes={block.c} link={host.openUrl} code={tone} />
              </T>
            );
          case "code":
            return <Code key={index} text={block.v} />;
          case "quote":
            return (
              <View key={index} style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ width: 3, borderRadius: 1.5, backgroundColor: ink.separator }} />
                <View style={{ flex: 1 }}>
                  <Blocks blocks={block.c} tone={ink.secondary} depth={depth + 1} />
                </View>
              </View>
            );
          case "list":
            return (
              <View key={index} style={{ gap: 6 }}>
                {block.items.map((item, at) => (
                  <View key={at} style={{ flexDirection: "row", gap: 8 }}>
                    <View style={{ minWidth: block.ordered ? 24 : 12, alignItems: "flex-end" }}>
                      <T color={item.checked == null ? ink.secondary : item.checked ? ink.blue : ink.secondary}>
                        {item.checked != null
                          ? item.checked
                            ? "☑"
                            : "☐"
                          : block.ordered
                            ? `${block.start + at}.`
                            : depth % 2 === 0
                              ? "•"
                              : "◦"}
                      </T>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Blocks blocks={item.c} tone={tone} depth={depth + 1} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case "table":
            return <Table key={index} block={block} tone={tone} />;
          case "hr":
            return <View key={index} style={{ height: 1, backgroundColor: ink.separator, marginVertical: 4 }} />;
        }
      })}
    </View>
  );
}

/** Assistant prose and Markdown tool output. Parsed once per text; a streaming cell re-parses only itself. */
export const Markdown = memo(function MarkdownView({
  text,
  tone = ink.label,
}: {
  readonly text: string;
  readonly tone?: TextStyle["color"];
}) {
  return <Blocks blocks={markdownBlocks(text)} tone={tone} depth={0} />;
});

export { MONO } from "./host.js";
