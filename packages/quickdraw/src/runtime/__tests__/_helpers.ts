/**
 * Shared fixtures for box-cadence host kit tests.
 * Hand-written paint batches — not produced by a product worker.
 */
import type { Buffer } from "../../buffer/index.js";
import type { LayoutNode } from "../../layout/index.js";
import type { BoxBusDownMessage, BoxBusUpMessage } from "../box_bus.js";
import type { BoxCadencePort, CadenceDownItem, TtyInput, TtyOutput } from "../renderer.js";

export const COMPOSER_BOX = 1;
export const BLOCK_BOX = 2;
export const SECOND_BLOCK_BOX = 3;

export function text(value: string, key: string): LayoutNode {
  return { type: "text", key, content: value };
}

export function composer(draft: string, width = 40): LayoutNode {
  return { type: "chrome_frame", key: "composer:frame", width, draft };
}

export function structure(gen: number, blockKeys: readonly { key: string; boxId: number }[]): BoxBusDownMessage {
  return {
    kind: "structure",
    gen,
    tree: {
      root: {
        type: "flex",
        key: "root",
        style: { direction: "column" },
        children: [
          ...blockKeys.map(({ key }) => ({ type: "box", key, children: [] }) as LayoutNode),
          { type: "box", key: "composer", children: [] } as LayoutNode,
        ],
      },
      boxes: Object.fromEntries([...blockKeys.map(({ key, boxId }) => [key, boxId]), ["composer", COMPOSER_BOX]]),
    },
  };
}

export function bufferRows(buffer: Buffer): string[] {
  const rows: string[] = [];
  for (let y = 0; y < buffer.height; y += 1) {
    let row = "";
    for (let x = 0; x < buffer.width; x += 1) {
      const cell = buffer.cells[y * buffer.width + x];
      row += cell?.placeholder ? "" : (cell?.ch ?? " ");
    }
    rows.push(row.replace(/\s+$/u, ""));
  }
  return rows;
}

export class FakeTtyInput implements TtyInput {
  readonly rawModeChanges: boolean[] = [];
  #handler: ((chunk: string) => void) | null = null;

  onData(handler: (chunk: string) => void): void {
    this.#handler = handler;
  }

  setRawMode(enabled: boolean): void {
    this.rawModeChanges.push(enabled);
  }

  type(chunk: string): void {
    this.#handler?.(chunk);
  }
}

export class FakeTtyOutput implements TtyOutput {
  readonly writes: string[] = [];
  cols: number;
  rows: number;
  #onResize: (() => void) | null = null;

  constructor(cols = 40, rows = 12) {
    this.cols = cols;
    this.rows = rows;
  }

  write(chunk: string): void {
    this.writes.push(chunk);
  }

  onResize(handler: () => void): void {
    this.#onResize = handler;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.#onResize?.();
  }
}

/** Paint-port double — no harness lane envelope. */
export class FakeBoxCadencePort implements BoxCadencePort {
  readonly posted: BoxBusUpMessage[] = [];
  readonly #handlers: Array<(batch: readonly CadenceDownItem[]) => void> = [];

  post(message: BoxBusUpMessage): void {
    this.posted.push(message);
  }

  onBatch(handler: (batch: readonly CadenceDownItem[]) => void): void {
    this.#handlers.push(handler);
  }

  emit(batch: readonly CadenceDownItem[]): void {
    for (const handler of this.#handlers) handler(batch);
  }
}
