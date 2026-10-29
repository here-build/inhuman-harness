/* eslint-disable compat/compat -- web companion targets current browsers; node browserslist still includes Opera Mini */
import { useEffect, useMemo, useRef } from "react";
import { FileDiff, type FileDiffMetadata, type ThemedDiffResult } from "@pierre/diffs";
import { WorkerPoolManager, type WorkerStats } from "@pierre/diffs/worker";

import { projectDiff, type DiffInput } from "./diff-model.js";
import type { ColorScheme } from "./highlight.js";
import { useScheme } from "./scheme.js";

const THEME = { light: "github-light-high-contrast", dark: "github-dark-default" } as const;

// The theme's own background reads as a second surface on the page. The page canvas inherits into the shadow root.
// Pierre mixes a changed line's color into the background again; at 0% the page's line tokens paint as they are.
// Context lines keep the mix, which lands them on the canvas.
const DIFF_CSS =
  ":host { --diffs-font-family: 'JetBrains Mono', monospace; --diffs-font-size: 13px; } * { --diffs-bg: var(--canvas) !important; --diffs-light-bg: var(--canvas) !important; --diffs-dark-bg: var(--canvas) !important; } [data-line-type^=change-] { --mix-light: 0% !important; --mix-dark: 0% !important; }";

/** Color variables only. Weight, style, and background would change the line box. */
const TOKEN_COLOR = ["--diffs-token-light", "--diffs-token-dark"] as const;

/** The next diff's worker waits until this one has finished. Layout does not. */
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

function diffWorker(): Worker {
  return new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module" });
}

function highlightSettled(stats: WorkerStats): boolean {
  return (
    stats.managerState === "initialized" &&
    stats.busyWorkers === 0 &&
    stats.activeTasks === 0 &&
    stats.queuedTasks === 0
  );
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
    const container = document.createElement("diffs-container");
    node.append(container);
    let cancelled = false;
    let laidOut = false;
    let colored = false;
    let pending: ThemedDiffResult | null = null;
    const apply = (): void => {
      const shadow = container.shadowRoot;
      if (cancelled || colored || !laidOut || pending == null || shadow == null) return;
      paintTokenColors(shadow, pending);
      colored = true;
    };
    const renderer = mountDiff(container, fileDiff, scheme, () => {
      laidOut = true;
      apply();
    });
    let release = (): void => {};
    let stopWorker = (): void => {};
    if (typeof Worker === "function") {
      const turn = takeHighlightTurn();
      release = turn.release;
      void turn.ready.then(() => {
        if (cancelled || !node.isConnected) {
          release();
          return undefined;
        }
        const pool = new WorkerPoolManager(
          { poolSize: 1, workerFactory: diffWorker },
          { theme: THEME, lineDiffType: "word-alt" },
        );
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          release();
          queueMicrotask(() => {
            pool.terminate();
          });
        };
        const instance = {
          __id: "diff-color",
          onHighlightSuccess(_diff: FileDiffMetadata, result: ThemedDiffResult): undefined {
            pending = result;
            if (!cancelled) apply();
            finish();
            return undefined;
          },
          onHighlightError(): undefined {
            finish();
            return undefined;
          },
        };
        let unsubscribe = (): void => {};
        unsubscribe = pool.subscribeToStatChanges((stats) => {
          if (settled) return;
          if (stats.workersFailed || highlightSettled(stats)) finish();
        });
        pool.highlightDiffAST(instance, fileDiff);
        stopWorker = () => {
          unsubscribe();
          pool.cleanUpTasks(instance);
          pool.terminate();
        };
        return undefined;
      });
    }
    return () => {
      cancelled = true;
      release();
      stopWorker();
      renderer.cleanUp();
      container.remove();
    };
  }, [model, scheme]);

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
