import { useEffect, useMemo, useRef } from "react";
import { FileDiff, type FileDiffMetadata, type ThemedDiffResult } from "@pierre/diffs";

import { projectDiff, type DiffInput } from "./diff-model.js";
import type { ColorScheme } from "./highlight.js";
import { useScheme } from "./scheme.js";
import { wasmHighlightDiff, type DiffHighlightResult } from "./syntax-wasm.js";

const THEME = { light: "github-light-high-contrast", dark: "github-dark-default" } as const;

// The theme's own background reads as a second surface on the page. The page canvas inherits into the shadow root.
// Pierre mixes a changed line's color into the background again; at 0% the page's line tokens paint as they are.
// Context lines keep the mix, which lands them on the canvas.
const DIFF_CSS = `
  :host { --diffs-font-family: var(--font-mono, 'Monaspace Krypton', monospace); --diffs-font-size: 14px; --diffs-line-height: 20px; }
  * { --diffs-bg: var(--canvas) !important; --diffs-light-bg: var(--canvas) !important; --diffs-dark-bg: var(--canvas) !important; }
  [data-line-type^=change-] { --mix-light: 0% !important; --mix-dark: 0% !important; }
  /* Keep Pierre's shared row sizing, but hang the intrinsic-width gutter off
     a zero-width track so code owns the full content width. */
  [data-code] { grid-template-columns: 0 minmax(0, 1fr); contain: none; overflow: visible; }
  [data-gutter] { grid-template-columns: minmax(0, 1fr); width: var(--gutter-width); justify-self: end; }
  [data-line], [data-no-newline] { padding-inline: 0; }
  /* One continuous separator spans the number gutter and code measure.
     Do not paint an extra trailing gutter beyond the code's right edge. */
  [data-unified] [data-separator=line-info] [data-separator-wrapper] {
    width: calc(100cqi + var(--gutter-width));
    padding-inline: 0;
    background-color: var(--diffs-bg-separator);
  }
  [data-separator-wrapper], [data-separator-content], [data-expand-button], [data-diff-span] {
    border-radius: 0 !important;
  }
`;

/** Color variables only. Weight, style, and background would change the line box. */
const TOKEN_COLOR = ["--diffs-token-light", "--diffs-token-dark"] as const;

/** The next diff's highlight turn waits until this one has finished. Layout does not. */
let highlightTurn: Promise<void> = Promise.resolve();

function takeHighlightTurn(): { readonly ready: Promise<void>; release(): void } {
  let release = (): void => {};
  const ticket = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const ready = highlightTurn;
  highlightTurn = highlightTurn.then(() => ticket);
  return { ready, release };
}

type HastNode = {
  readonly type?: string;
  readonly value?: string;
  readonly properties?: { readonly style?: unknown; readonly [key: string]: unknown };
  readonly children?: readonly unknown[];
};

function isHastNode(value: unknown): value is HastNode {
  return value != null && typeof value === "object";
}

function isStyleRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function tokenColor(style: unknown): string | null {
  const kept: string[] = [];
  if (typeof style === "string") {
    for (const part of style.split(";")) {
      const name = part.slice(0, part.indexOf(":")).trim();
      const value = part.slice(part.indexOf(":") + 1).trim();
      if (name === "--diffs-token-light" || name === "--diffs-token-dark") kept.push(`${name}:${value}`);
    }
  } else if (isStyleRecord(style)) {
    for (const name of TOKEN_COLOR) {
      const value = style[name];
      if (typeof value === "string" && value !== "") kept.push(`${name}:${value}`);
    }
  }
  return kept.length > 0 ? kept.join(";") : null;
}

type TokenRun = { readonly text: string; readonly color: string | null };

function collectRuns(node: unknown, inherited: string | null, runs: TokenRun[]): void {
  if (!isHastNode(node)) return;
  if (node.type === "text") {
    if (typeof node.value === "string" && node.value !== "") runs.push({ text: node.value, color: inherited });
    return;
  }
  if (node.type !== "element" || node.children == null) return;
  const color = tokenColor(node.properties?.style) ?? inherited;
  for (const child of node.children) collectRuns(child, color, runs);
}

function lineKey(type: unknown, line: unknown): string | null {
  if (typeof line !== "number" && typeof line !== "string") return null;
  const kind = typeof type === "string" ? type : "";
  return `${kind}\0${line}`;
}

/**
 * Set token color on the lines already in the shadow root.
 * The line elements and their text stay put, so wrapping does not move.
 */
export function paintTokenColors(root: ParentNode, result: ThemedDiffResult): void {
  const byLine = new Map<string, TokenRun[]>();
  for (const node of [...result.code.deletionLines, ...result.code.additionLines]) {
    if (node.type !== "element") continue;
    const key = lineKey(node.properties["data-line-type"], node.properties["data-line"]);
    if (key == null) continue;
    const runs: TokenRun[] = [];
    collectRuns(node, null, runs);
    if (runs.some((run) => run.color != null)) byLine.set(key, runs);
  }
  for (const line of root.querySelectorAll<HTMLElement>("[data-content] [data-line]")) {
    const runs = byLine.get(lineKey(line.dataset.lineType, line.dataset.line) ?? "");
    if (runs == null) continue;
    const expected = runs.map((run) => run.text).join("");
    if (line.textContent !== expected) continue;
    paintLine(line, runs);
  }
}

export function paintDiffRuns(root: ParentNode, diff: DiffHighlightResult, baseLine = 1): void {
  for (const line of root.querySelectorAll<HTMLElement>("[data-content] [data-line]")) {
    if (line.querySelector("span[style*='--diffs-token-']") != null) continue;
    const lineNum = Number(line.dataset.line);
    if (!Number.isFinite(lineNum)) continue;
    const index = lineNum - baseLine;
    const side = line.dataset.lineType === "change-deletion" ? diff.oldLines : diff.newLines;
    const runs = side.at(index);
    if (!runs?.some((run) => run.color != null)) continue;
    const expected = runs.map((run) => run.text).join("");
    if (line.textContent !== expected) continue;
    paintLine(
      line,
      runs.map((run) => ({ text: run.text, color: run.color ?? null })),
    );
  }
}

function paintLine(line: HTMLElement, runs: readonly TokenRun[]): void {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    if (node instanceof Text) nodes.push(node);
  }
  let index = 0;
  let offset = 0;
  for (const textNode of nodes) {
    const value = textNode.data;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    while (cursor < value.length) {
      const run = runs.at(index);
      if (run == null) return;
      const take = Math.min(value.length - cursor, run.text.length - offset);
      const slice = value.slice(cursor, cursor + take);
      if (slice !== run.text.slice(offset, offset + take)) return;
      if (run.color == null) fragment.append(slice);
      else {
        const span = document.createElement("span");
        span.setAttribute("style", run.color);
        span.textContent = slice;
        fragment.append(span);
      }
      cursor += take;
      offset += take;
      if (offset >= run.text.length) {
        index += 1;
        offset = 0;
      }
    }
    textNode.replaceWith(fragment);
  }
}

function mountDiff(
  container: HTMLElement,
  fileDiff: FileDiffMetadata,
  scheme: ColorScheme,
  onPaint: () => void,
): FileDiff {
  // Pierre's React wrapper hydrates the same shadow root on StrictMode's
  // remount, leaving an empty pre behind. Give every renderer lifetime a
  // fresh container, including during HMR, and dispose it symmetrically.
  const renderer = new FileDiff({
    diffStyle: "unified",
    diffIndicators: "bars",
    lineDiffType: "word-alt",
    theme: THEME,
    themeType: scheme,
    disableFileHeader: true,
    overflow: "wrap",
    // A diff longer than this is painted as plain text. Zero keeps the grammar
    // off this thread; the line boxes, including word marks, are the layout.
    tokenizeMaxLength: 0,
    unsafeCSS: DIFF_CSS,
    onPostRender(_node, _instance, phase) {
      if (phase !== "unmount") onPaint();
    },
  });
  renderer.render({ fileDiff, fileContainer: container });
  return renderer;
}

export function DiffView({ oldText, newText, path, lineStart }: DiffInput) {
  const scheme = useScheme();
  const host = useRef<HTMLDivElement>(null);
  const model = useMemo(() => projectDiff({ oldText, newText, path, lineStart }), [oldText, newText, path, lineStart]);

  useEffect(() => {
    const node = host.current;
    if (model.status !== "diff" || node == null) return;
    const fileDiff = model.fileDiff;
    const baseLine = lineStart != null && Number.isFinite(lineStart) && lineStart > 1 ? Math.floor(lineStart) : 1;
    const container = document.createElement("diffs-container");
    node.append(container);
    let cancelled = false;
    let laidOut = false;
    let pending: DiffHighlightResult | null = null;
    const apply = (): void => {
      const shadow = container.shadowRoot;
      if (cancelled || !laidOut || pending == null || shadow == null) return;
      paintDiffRuns(shadow, pending, baseLine);
    };
    const renderer = mountDiff(container, fileDiff, scheme, () => {
      laidOut = true;
      apply();
    });
    const turn = takeHighlightTurn();
    const release = turn.release;
    const runHighlight = async (): Promise<void> => {
      await turn.ready;
      try {
        if (!node.isConnected) return;
        const result = await wasmHighlightDiff(oldText, newText, path);
        if (result != null) {
          pending = result;
          apply();
        }
      } finally {
        release();
      }
    };
    void runHighlight();
    return () => {
      cancelled = true;
      release();
      renderer.cleanUp();
      container.remove();
    };
  }, [lineStart, model, newText, oldText, path, scheme]);

  return (
    <div className="diff" aria-label={path === "" ? "Diff" : path}>
      {path === "" ? null : <p className="diff-path mono">{path}</p>}
      {model.status === "diff" ? (
        <div ref={host} />
      ) : (
        <p className="diff-note">{model.status === "empty" ? "Empty file" : "No changes"}</p>
      )}
    </div>
  );
}
