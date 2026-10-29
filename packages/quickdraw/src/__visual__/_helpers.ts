/**
 * Structural dump for the visual project. Appearance oracles are this
 * record — not ANSI, not eight toContain on painted strings.
 */
import type { LayoutNode } from "../layout/index.js";
import { rasterLayout } from "../runtime/raster.js";

export type NodeDump = {
  type?: string;
  key?: string;
  kind?: string;
  role?: string;
  prominence?: number;
  bgRole?: string;
  bgProminence?: number;
  gutter?: unknown;
  collapsed?: boolean;
  draft?: string;
  completion?: string;
  annotation?: string;
  annotationRole?: string;
  placeholder?: string;
  progress?: number;
  statusItems?: string[];
  glyphs?: string[];
  href?: string;
  underline?: boolean;
  strike?: boolean;
  bold?: boolean;
  userSelect?: string;
  live?: unknown;
  texts: string[];
  children?: NodeDump[];
};

export type FrameDump = {
  size: { w: number; h: number };
  chars: string[];
  tree: NodeDump;
};

export function dumpNode(node: unknown): NodeDump {
  const rec = asRecord(node);
  const styleBg = styleBag(rec.style)?.background;
  const dump: NodeDump = {
    type: str(rec.type),
    key: str(rec.key),
    kind: str(rec.kind),
    role: styleField(rec.style, "role"),
    prominence: styleNum(rec.style, "prominence"),
    bgRole: styleField(rec.style, "bgRole") ?? styleField(styleBg, "bgRole"),
    bgProminence: styleNum(rec.style, "bgProminence") ?? styleNum(styleBg, "bgProminence"),
    gutter: dumpGutter(rec.gutter),
    collapsed: typeof rec.collapsed === "boolean" ? rec.collapsed : undefined,
    draft: str(rec.draft),
    completion: str(rec.completion),
    annotation: str(rec.annotation),
    annotationRole: str(rec.annotationRole),
    placeholder: str(rec.placeholder),
    progress: typeof rec.progress === "number" ? rec.progress : undefined,
    statusItems: strList(rec.statusItems),
    glyphs: strList(rec.bodyGlyphs),
    href: styleField(rec.style, "href") ?? segStr(rec.bodySegRows, "href"),
    underline: styleFlag(rec.style, "underline") ?? segFlag(rec.bodySegRows, "underline"),
    strike: styleFlag(rec.style, "strike"),
    bold: styleFlag(rec.style, "bold"),
    userSelect: str(rec.userSelect) ?? str(rec.bodyUserSelect),
    live: rec.live,
    texts: collectTexts(node),
  };
  const kids: unknown[] = [];
  if (rec.summary !== undefined) kids.push(rec.summary);
  if (Array.isArray(rec.children)) kids.push(...rec.children);
  if (kids.length > 0) dump.children = kids.map(dumpNode);
  return omitUndefined(dump);
}

export function paintChars(
  node: LayoutNode,
  w: number,
  h: number,
  opts: { nowMs?: number; birth?: ReadonlyMap<string, number> } = {},
): string[] {
  return rasterLayout(node, w, h, { nowMs: opts.nowMs ?? Date.now(), birth: opts.birth });
}

export function dumpFrame(
  node: LayoutNode,
  w: number,
  h: number,
  opts: { nowMs?: number; birth?: ReadonlyMap<string, number> } = {},
): FrameDump {
  return {
    size: { w, h },
    chars: paintChars(node, w, h, opts),
    tree: dumpNode(node),
  };
}

function collectTexts(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  const rec = node as {
    type?: unknown;
    content?: unknown;
    draft?: unknown;
    placeholder?: unknown;
    annotation?: unknown;
    summary?: unknown;
    children?: unknown;
    bodySegRows?: unknown;
  };
  const out: string[] = [];
  if (
    (rec.type === "text" || rec.type === "markdown") &&
    typeof rec.content === "string" &&
    rec.content.trim() !== ""
  ) {
    out.push(rec.content);
  }
  if (typeof rec.draft === "string" && rec.draft.trim() !== "") out.push(rec.draft);
  if (typeof rec.placeholder === "string" && rec.placeholder.trim() !== "") {
    out.push(rec.placeholder);
  }
  if (typeof rec.annotation === "string" && rec.annotation.trim() !== "") {
    out.push(rec.annotation);
  }
  if (rec.summary !== undefined) out.push(...collectTexts(rec.summary));
  if (Array.isArray(rec.bodySegRows)) {
    for (const row of rec.bodySegRows) {
      if (!Array.isArray(row)) continue;
      const line = row
        .map((seg) => (typeof (seg as { text?: unknown }).text === "string" ? (seg as { text: string }).text : ""))
        .join("")
        .trim();
      if (line !== "") out.push(line);
    }
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) out.push(...collectTexts(child));
  }
  return out;
}

function dumpGutter(gutter: unknown): unknown {
  if (typeof gutter !== "object" || gutter === null) return undefined;
  const rec = gutter as {
    kind?: unknown;
    profile?: unknown;
    rows?: unknown;
    glyph?: unknown;
    top?: unknown;
    bottom?: unknown;
    mid?: unknown;
  };
  if (rec.kind === "spinner") {
    return {
      kind: "spinner",
      profile: typeof rec.profile === "string" ? rec.profile : "working",
      ...(rec.rows === "top" || rec.rows === "all" ? { rows: rec.rows } : {}),
    };
  }
  if (typeof rec.kind === "string") {
    return {
      kind: rec.kind,
      glyph: rec.glyph,
      top: rec.top,
      bottom: rec.bottom,
      mid: rec.mid,
    };
  }
  return undefined;
}

function asRecord(node: unknown): Record<string, unknown> {
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = value.filter((item): item is string => typeof item === "string");
  return next.length > 0 ? next : undefined;
}

function styleBag(style: unknown): Record<string, unknown> | undefined {
  return typeof style === "object" && style !== null ? (style as Record<string, unknown>) : undefined;
}

function styleField(style: unknown, key: string): string | undefined {
  return str(styleBag(style)?.[key]);
}

function styleNum(style: unknown, key: string): number | undefined {
  const n = styleBag(style)?.[key];
  return typeof n === "number" ? n : undefined;
}

function styleFlag(style: unknown, key: string): true | undefined {
  return styleBag(style)?.[key] === true ? true : undefined;
}

function segStr(rows: unknown, key: string): string | undefined {
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const seg of row) {
      const hit = str(asRecord(seg)[key]);
      if (hit) return hit;
    }
  }
  return undefined;
}

function segFlag(rows: unknown, key: string): true | undefined {
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const seg of row) {
      if (asRecord(seg)[key] === true) return true;
    }
  }
  return undefined;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const next = { ...value };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}
