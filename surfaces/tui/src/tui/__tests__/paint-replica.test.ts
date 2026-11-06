import { expect, test } from "vitest";

import {
  createCompletion,
  createPaintRoot,
  createTurn,
  speechOf,
  thinkingOf,
  type CompletionPaintInstance,
  type TurnPaintInstance,
} from "../paint-dom.js";
import { createPaintReader, createPaintWriter, type PaintDownMessage } from "../paint-transport.js";

async function flushMicrotask(): Promise<void> {
  await Promise.resolve();
}

function livePair(epoch = "e1"): {
  writerRoot: ReturnType<typeof createPaintRoot>;
  writer: ReturnType<typeof createPaintWriter>;
  reader: ReturnType<typeof createPaintReader>;
  posted: PaintDownMessage[];
} {
  const posted: PaintDownMessage[] = [];
  const writer = createPaintWriter(epoch, (message) => posted.push(message));
  const writerRoot = createPaintRoot();
  const turn = createTurn();
  turn.appendChild(createCompletion({ workerPresent: true, model: "m" }));
  writerRoot.appendChild(turn);
  writer.attach(writerRoot);
  const reader = createPaintReader();
  const init = posted[0];
  if (init === undefined || init.kind !== "paint_init") {
    throw new Error("expected paint_init");
  }
  reader.apply(init);
  return { writerRoot, writer, reader, posted };
}

function readerTurn(reader: ReturnType<typeof createPaintReader>): TurnPaintInstance {
  const node = reader.root?.children[0];
  if (node === undefined || node.kind !== "turn") throw new Error("missing turn");
  return node as TurnPaintInstance;
}

function readerCompletion(turn: TurnPaintInstance): CompletionPaintInstance {
  const node = turn.children[0];
  if (node === undefined || node.kind !== "completion") throw new Error("missing completion");
  return node as CompletionPaintInstance;
}

function writerCompletion(root: ReturnType<typeof createPaintRoot>): CompletionPaintInstance {
  const turn = root.children[0];
  if (turn === undefined || turn.kind !== "turn") throw new Error("missing writer turn");
  const completion = (turn as TurnPaintInstance).children[0];
  if (completion === undefined || completion.kind !== "completion") {
    throw new Error("missing writer completion");
  }
  return completion as CompletionPaintInstance;
}

test("leaf text patch preserves completion, turn, and sibling pointers", async () => {
  const { writerRoot, reader, posted } = livePair();
  const firstTurn = readerTurn(reader);
  const completion = readerCompletion(firstTurn);
  const speech = speechOf(completion);
  const thinking = thinkingOf(completion);

  const sibling = createTurn();
  sibling.appendChild(createCompletion());
  writerRoot.appendChild(sibling);
  await flushMicrotask();
  reader.apply(posted[posted.length - 1]!);

  const writerTurnCompletion = writerCompletion(writerRoot);
  speechOf(writerTurnCompletion).updateText("hello");
  thinkingOf(writerTurnCompletion).updateText("hmm");
  await flushMicrotask();
  reader.apply(posted[posted.length - 1]!);

  expect({
    turn: readerTurn(reader) === firstTurn,
    completion: readerCompletion(firstTurn) === completion,
    speech: speechOf(completion) === speech,
    thinking: thinkingOf(completion) === thinking,
    children: reader.root?.children.length,
    speechText: speech.text,
    thinkingText: thinking.text,
  }).toEqual({
    turn: true,
    completion: true,
    speech: true,
    thinking: true,
    children: 2,
    speechText: "hello",
    thinkingText: "hmm",
  });
});

test.each([
  {
    name: "patch-before-init",
    apply: () => {
      createPaintReader().apply({ kind: "paint_patch", epoch: "e", seq: 1, patches: [] });
    },
    code: "patch_before_init",
  },
  {
    name: "seq_gap",
    apply: () => {
      livePair("e1").reader.apply({ kind: "paint_patch", epoch: "e1", seq: 2, patches: [] });
    },
    code: "seq_gap",
  },
])("protocol error: $name", ({ apply, code }) => {
  try {
    apply();
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
});
