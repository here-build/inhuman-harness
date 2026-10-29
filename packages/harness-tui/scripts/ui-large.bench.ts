/**
 * Large-session UI bench. Not part of `pnpm test`.
 *
 *   pnpm exec vitest run --config vitest.bench.config.ts
 *
 * Two planes:
 *   logic  — paint-controller spine sync, which runs on every transcript change
 *   present — retained prepare + layout + paint of that replica
 */
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  FileMutateToolJob,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { createBuffer } from "@inhuman.tools/quickdraw/buffer";
import { layout, paintFrame, paintTheme, type LayoutNode } from "@inhuman.tools/quickdraw/layout";
import { createPaintLocal, writePaintTapeScroll } from "@inhuman.tools/quickdraw/runtime";
import { bootSyntax } from "@inhuman.tools/quickdraw/widgets";
import { expect, test } from "vitest";

import { createPaintController } from "../src/tui/paint-controller.js";
import {
  createCompletion,
  createComposer,
  createPaintRoot,
  createSpeech,
  createStack,
  createStatusline,
  createTurn,
  createWorkCell,
  speechOf,
} from "../src/tui/paint-dom.js";
import { createHarnessPaintSource } from "../src/tui/paint-source.js";
import { createPaintReader, createPaintWriter, type PaintDownMessage } from "../src/tui/paint-transport.js";

const COLS = 100;
const ROWS = 40;
const REPLY = [
  "Keeping a long session on the screen.",
  "",
  "The reply is markdown with a fence so expand has real work:",
  "",
  "```ts",
  "export function place(node: Node, clip: Rect) {",
  "  return node;",
  "}",
  "```",
  "",
  "Trailing words so wrap is not a single line. ".repeat(12),
].join("\n");

function fileBody(lines: number, salt: string): string {
  return Array.from({ length: lines }, (_, i) => `export const ${salt}_${i} = ${i};`).join("\n");
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function time(fn: () => void, loops = 5): number {
  const samples: number[] = [];
  for (let i = 0; i < loops; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function buildTurns(count: number, fileLines: number): { turns: SessionTurn[]; live: CompletionExpectation } {
  let tail: SessionSystemPrompt | SessionTurn = new SessionSystemPrompt();
  const turns: SessionTurn[] = [];
  let live: CompletionExpectation | null = null;
  for (let i = 0; i < count; i++) {
    const expectation = new CompletionExpectation({ connectionId: "bench" });
    expectation.responseText = `## turn ${i}\n\n${REPLY}`;
    expectation.model = "bench";
    expectation.startedAtMs = 1_700_000_000_000 + i * 1000;
    expectation.thoughtEndedAtMs = expectation.startedAtMs + 20;
    expectation.endedAtMs = expectation.startedAtMs + 40;
    if (i < count - 1) expectation.outcome = "successful";
    const completion = new CompletionJob({ expectation });
    const prior = fileBody(fileLines, `t${i}`);
    const edit = new FileMutateToolJob({
      toolCallId: `edit-${i}`,
      name: "edit_file",
      argsJson: JSON.stringify({
        path: `src/file-${i}.ts`,
        old_string: `export const t${i}_0 = 0;`,
        new_string: `export const t${i}_0 = 1;`,
      }),
      priorContent: prior,
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, value: "edited" }),
    });
    const shell = new SystemToolJob({
      toolCallId: `shell-${i}`,
      name: "shell",
      argsJson: JSON.stringify({ command: "cat file" }),
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, value: { stdout: prior } }),
    });
    const turn = new SessionTurn({
      tail,
      prompt: prompt.user`turn ${i}: update the module and show the file`,
      queue: [],
      reducerExited: i < count - 1,
      doneWork: [completion, edit, shell],
    });
    turns.push(turn);
    tail = turn;
    live = expectation;
  }
  if (live === null) throw new Error("no turns");
  return { turns, live };
}

function present(root: LayoutNode | null): { ops: number } {
  if (root === null) return { ops: 0 };
  const frame = layout(root, { w: COLS, h: ROWS });
  const buf = createBuffer(COLS, ROWS);
  paintFrame(frame, buf, paintTheme(), { nowMs: 0 });
  return { ops: frame.paintOrder.length };
}

test("large session: spine sync and present", { timeout: 60_000 }, async () => {
  const lines: string[] = [];
  const log = (row: string) => {
    lines.push(row);
    console.log(row);
  };
  log(`\nlogic plane — full spine sync (what one transcript change reruns)\n`);

  for (const [turns, fileLines] of [
    [20, 200],
    [40, 400],
    [80, 800],
  ] as const) {
    const built = buildTurns(turns, fileLines);
    const paint = createPaintController(() => {}, "bench");
    paint.attach();
    const cold = time(() => paint.syncSpine(built.turns), 3);
    built.live.responseText += " more";
    const token = time(() => paint.syncSpine(built.turns), 5);
    log(
      `turns ${String(turns).padStart(3)} × file ${String(fileLines).padStart(4)} lines   cold ${cold.toFixed(1).padStart(7)}ms   per token ${token.toFixed(1).padStart(7)}ms`,
    );
    paint[Symbol.dispose]();
  }

  log(`\npresent plane — retained widgets, then layout+paint\n`);
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("bench", (message) => posted.push(message));
  const root = createPaintRoot();
  const tape = createStack();
  root.appendChild(tape);
  root.appendChild(createComposer());
  root.appendChild(createStatusline());
  const speeches = [];
  for (let i = 0; i < 120; i++) {
    const turn = createTurn();
    tape.appendChild(turn);
    turn.appendChild(createSpeech(`prompt ${i}: keep the tape moving`, "user", 1_700_000_000_000 + i));
    const completion = createCompletion({
      state: "successful",
      startedAt: 1_700_000_000_000 + i,
      durationMs: 30,
    });
    const speech = speechOf(completion);
    speech.updateText(`## reply ${i}\n\n${REPLY}`);
    speeches.push(speech);
    turn.appendChild(completion);
  }
  writer.attach(root);

  const reader = createPaintReader();
  reader.apply(posted[0]!);
  const source = createHarnessPaintSource({ reader });
  const local = createPaintLocal(COLS, ROWS);
  source.bind({ requestPaint() {} }, local);

  const coldPrepare = time(() => source.prepare(), 1);
  const prepared = source.prepare();
  const layoutSamples: number[] = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    present(prepared.root);
    layoutSamples.push(performance.now() - t0);
  }
  log(
    `120 replies                  prepare first ${coldPrepare.toFixed(1)}ms   layout+paint first ${layoutSamples[0]!.toFixed(1)}ms steady ${median(layoutSamples.slice(1)).toFixed(1)}ms   ops ${present(prepared.root).ops}`,
  );
  if (prepared.root !== null) {
    let firstMeasure = 0;
    let secondMeasure = 0;
    const count = (bucket: "a" | "b") => (text: string) => {
      if (text.length > 40) {
        if (bucket === "a") firstMeasure += 1;
        else secondMeasure += 1;
      }
      return text.length;
    };
    layout(prepared.root, { w: COLS, h: ROWS }, { measure: count("a") });
    layout(prepared.root, { w: COLS, h: ROWS }, { measure: count("b") });
    log(`  stamp check (long-string measures, 2nd fn is a cache miss): first ${firstMeasure}  second ${secondMeasure}`);
  }

  const tail = speeches.at(-1)!;
  tail.updateText(`${tail.text}\n\nand one more sentence on the live reply.`);
  await Promise.resolve();
  reader.apply(posted.at(-1)!);
  const tokenPrepare = time(() => source.prepare(), 1);
  const tokenTree = source.prepare();
  const tokenPresent = time(() => present(tokenTree.root), 4);
  log(`one more sentence             prepare ${tokenPrepare.toFixed(1)}ms   layout+paint ${tokenPresent.toFixed(1)}ms`);

  writePaintTapeScroll(local, 200, false);
  const scrollPrepare = time(() => source.prepare(), 1);
  const scrolled = source.prepare();
  const scrollSamples: number[] = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    present(scrolled.root);
    scrollSamples.push(performance.now() - t0);
  }
  log(
    `scroll to row 200             prepare ${scrollPrepare.toFixed(1)}ms   layout+paint first ${scrollSamples[0]!.toFixed(1)}ms steady ${median(scrollSamples.slice(1)).toFixed(1)}ms`,
  );

  const diffOld = fileBody(900, "before");
  const diffNew = diffOld.replace("before_10 = 10;", "before_10 = 11;");
  const diffCell = createWorkCell("tool");
  diffCell.setFace({
    name: "edit_file",
    object: "src/big.ts",
    status: "",
    state: "ok",
    indent: false,
    receiptKind: "diff",
    receiptText: "",
    diffOld,
    diffNew,
    diffPath: "src/big.ts",
  });
  const diffTurn = createTurn();
  tape.appendChild(diffTurn);
  diffTurn.appendChild(diffCell);
  await Promise.resolve();
  reader.apply(posted.at(-1)!);
  const diffPrepare = time(() => source.prepare(), 1);
  const diffTree = source.prepare();
  const diffSamples: number[] = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    present(diffTree.root);
    diffSamples.push(performance.now() - t0);
  }
  log(
    `+ open 900-line diff plain    prepare ${diffPrepare.toFixed(1)}ms   layout+paint first ${diffSamples[0]!.toFixed(1)}ms steady ${median(diffSamples.slice(1)).toFixed(1)}ms   ops ${present(diffTree.root).ops}`,
  );

  await bootSyntax("dark");
  await Promise.resolve();
  const hiPrepare = time(() => source.prepare(), 1);
  const hiTree = source.prepare();
  const hiSamples: number[] = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    present(hiTree.root);
    hiSamples.push(performance.now() - t0);
  }
  log(
    `same diff after shiki warm    prepare ${hiPrepare.toFixed(1)}ms   layout+paint first ${hiSamples[0]!.toFixed(1)}ms steady ${median(hiSamples.slice(1)).toFixed(1)}ms   ops ${present(hiTree.root).ops}`,
  );

  expect(lines.length).toBeGreaterThan(4);
});
