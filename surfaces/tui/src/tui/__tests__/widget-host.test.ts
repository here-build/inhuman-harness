import { expect, test } from "vitest";

import {
  createCompletion,
  createPaintRoot,
  createTurn,
  speechOf,
  type CompletionPaintInstance,
  type PaintNodeInstance,
  type TurnPaintInstance,
} from "../paint-dom.js";
import { createPaintReader, createPaintWriter, type PaintDownMessage } from "../paint-transport.js";
import { WidgetHost, type RetainedWidget } from "../widget-host.js";

class Probe implements RetainedWidget {
  dirty = true;
  disposed = 0;
  constructor(
    readonly node: PaintNodeInstance,
    readonly parent: RetainedWidget | null,
  ) {}
  prepare(width: number) {
    this.dirty = false;
    return {
      width,
      root: { type: "box" as const, children: [] },
      measured: { w: width, h: 1 },
      birthSites: [],
      progressSites: [],
    };
  }
  markDirty() {
    this.dirty = true;
    this.parent?.markDirty();
  }
  dispose() {
    this.disposed += 1;
  }
}

async function flushMicrotask(): Promise<void> {
  await Promise.resolve();
}

test("widget host lifecycle: stable across patch, dispose on remove, epoch remount", async () => {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => posted.push(message));
  const writerRoot = createPaintRoot();
  const turn = createTurn();
  turn.appendChild(createCompletion());
  writerRoot.appendChild(turn);
  writer.attach(writerRoot);
  const reader = createPaintReader();
  reader.apply(posted[0]!);
  const host = new WidgetHost((node, parent) => new Probe(node, parent));

  const rootWidget = host.widgetFor(reader.root as PaintNodeInstance);
  const readerTurn = reader.root!.children[0] as TurnPaintInstance;
  const turnWidget = host.widgetFor(readerTurn, rootWidget) as Probe;
  const completion = readerTurn.children[0] as CompletionPaintInstance;
  const completionWidget = host.widgetFor(completion, turnWidget) as Probe;

  writerRoot.appendChild(createTurn());
  await flushMicrotask();
  reader.apply(posted[posted.length - 1]!);
  const siblingWidget = host.widgetFor(reader.root!.children[1] as PaintNodeInstance, rootWidget) as Probe;

  speechOf((writerRoot.children[0] as TurnPaintInstance).children[0] as CompletionPaintInstance).updateText("x");
  await flushMicrotask();
  reader.apply(posted[posted.length - 1]!);

  expect({
    turn: host.widgetFor(reader.root!.children[0] as PaintNodeInstance, rootWidget) === turnWidget,
    completion: host.widgetFor(completion, turnWidget) === completionWidget,
    disposed: [turnWidget.disposed, completionWidget.disposed, siblingWidget.disposed],
  }).toEqual({
    turn: true,
    completion: true,
    disposed: [0, 0, 0],
  });

  writerRoot.removeChildAt(1);
  await flushMicrotask();
  reader.apply(posted[posted.length - 1]!);
  expect({
    removed: siblingWidget.disposed,
    kept: turnWidget.disposed,
    remaining: host.widgetFor(reader.root!.children[0] as PaintNodeInstance, rootWidget) === turnWidget,
  }).toEqual({
    removed: 1,
    kept: 0,
    remaining: true,
  });

  const init = posted[0];
  if (init === undefined || init.kind !== "paint_init") throw new Error("init");
  reader.apply({ ...init, epoch: "e2" });
  expect({ turn: turnWidget.disposed, completion: completionWidget.disposed }).toEqual({
    turn: 1,
    completion: 1,
  });
});
