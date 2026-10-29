import type { PhrasingContent, RootContent, TableCell } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import remend from "remend";

/**
 * Markdown as the native renderer draws it: a small tree both the parser and the view agree on.
 * The web renders the same text through react-markdown (remark + GFM); this is the same parser
 * family, minus the DOM. Raw HTML has no native form and is kept as its source text.
 */
export type Inline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "strong" | "em" | "del"; readonly c: readonly Inline[] }
  | { readonly t: "code"; readonly v: string }
  | { readonly t: "link"; readonly url: string; readonly c: readonly Inline[] }
  | { readonly t: "image"; readonly url: string; readonly alt: string }
  | { readonly t: "br" };

export type ListItem = { readonly checked: boolean | null; readonly c: readonly Block[] };

export type Block =
  | { readonly t: "p"; readonly c: readonly Inline[] }
  | { readonly t: "h"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly c: readonly Inline[] }
  | { readonly t: "code"; readonly lang: string; readonly v: string }
  | { readonly t: "quote"; readonly c: readonly Block[] }
  | { readonly t: "list"; readonly ordered: boolean; readonly start: number; readonly items: readonly ListItem[] }
  | {
      readonly t: "table";
      readonly align: readonly ("left" | "right" | "center" | null)[];
      readonly head: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly t: "hr" };

function inline(node: PhrasingContent): Inline[] {
  switch (node.type) {
    case "text":
      return [{ t: "text", v: node.value }];
    case "strong":
      return [{ t: "strong", c: node.children.flatMap(inline) }];
    case "emphasis":
      return [{ t: "em", c: node.children.flatMap(inline) }];
    case "delete":
      return [{ t: "del", c: node.children.flatMap(inline) }];
    case "inlineCode":
      return [{ t: "code", v: node.value }];
    case "link":
      return [{ t: "link", url: node.url, c: node.children.flatMap(inline) }];
    case "image":
      return [{ t: "image", url: node.url, alt: node.alt ?? "" }];
    case "break":
      return [{ t: "br" }];
    case "html":
      return [{ t: "text", v: node.value }];
    case "linkReference":
    case "footnoteReference":
    case "imageReference":
      return "children" in node ? node.children.flatMap(inline) : [];
    default:
      return [];
  }
}

function cells(row: readonly TableCell[]): Inline[][] {
  return row.map((cell) => cell.children.flatMap(inline));
}

function block(node: RootContent): Block[] {
  switch (node.type) {
    case "paragraph":
      return [{ t: "p", c: node.children.flatMap(inline) }];
    case "heading":
      return [{ t: "h", level: node.depth, c: node.children.flatMap(inline) }];
    case "code":
      return [{ t: "code", lang: node.lang ?? "", v: node.value }];
    case "blockquote":
      return [{ t: "quote", c: node.children.flatMap(block) }];
    case "list":
      return [
        {
          t: "list",
          ordered: node.ordered === true,
          start: node.start ?? 1,
          items: node.children.map((item) => ({
            checked: item.checked ?? null,
            c: item.children.flatMap(block),
          })),
        },
      ];
    case "table": {
      const [head = [], ...rows] = node.children.map((row) => cells(row.children));
      return [{ t: "table", align: node.align ?? [], head, rows }];
    }
    case "thematicBreak":
      return [{ t: "hr" }];
    case "html":
      return [{ t: "p", c: [{ t: "text", v: node.value }] }];
    default:
      return [];
  }
}

/** Parse without memory. */
export function parseMarkdown(text: string): readonly Block[] {
  const tree = fromMarkdown(remend(text), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return tree.children.flatMap(block);
}

const MEMORY = 400;
const parsed = new Map<string, readonly Block[]>();

/** A cell re-renders when any neighbour changes; the same text must not be parsed twice. Streaming text is a new key each token and ages out. */
export function markdownBlocks(text: string): readonly Block[] {
  const known = parsed.get(text);
  if (known != null) {
    parsed.delete(text);
    parsed.set(text, known);
    return known;
  }
  const blocks = parseMarkdown(text);
  parsed.set(text, blocks);
  if (parsed.size > MEMORY) {
    const oldest = parsed.keys().next();
    if (oldest.done !== true) parsed.delete(oldest.value);
  }
  return blocks;
}

/** The text a block contributes when copied or read aloud. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case "text":
        case "code":
          return node.v;
        case "br":
          return "\n";
        case "image":
          return node.alt;
        default:
          return inlineText(node.c);
      }
    })
    .join("");
}
