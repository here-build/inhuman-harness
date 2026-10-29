import { KernelPlexus, KernelRoot, SessionPlexus } from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import { expect, test } from "vitest";

import { paintChildrenOf } from "../paint-dom.js";
import { createPaintReader, type PaintDownMessage } from "../paint-transport.js";
import { Tea } from "../tea.js";

function localClient(): Client {
  return new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot()),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
}

function replicaOf(posted: readonly PaintDownMessage[]): { draft: string; cursor: number; mark: number | null } | null {
  const reader = createPaintReader();
  for (const message of posted) reader.apply(message);
  const root = reader.root;
  if (root === null) return null;
  const composer = paintChildrenOf(root).find((child) => child.kind === "composer");
  if (composer?.kind !== "composer") return null;
  return { draft: composer.draft, cursor: composer.cursor, mark: composer.mark };
}

test("Tea insert/backspace/delete replace the selected range", async () => {
  using tea = new Tea(localClient(), () => undefined, { draft: "hello" });
  tea.handle({ kind: "input_events", events: [{ key: "ComposerCaret:5:0" }] });

  using typed = new Tea(localClient(), () => undefined, { draft: "hello" });
  typed.handle({ kind: "input_events", events: [{ key: "ComposerCaret:5:0" }, { key: "x" }] });

  using backspaced = new Tea(localClient(), () => undefined, { draft: "hello" });
  backspaced.handle({ kind: "input_events", events: [{ key: "ComposerCaret:5:0" }, { key: "Backspace" }] });

  using deleted = new Tea(localClient(), () => undefined, { draft: "hello" });
  deleted.handle({ kind: "input_events", events: [{ key: "ComposerCaret:5:0" }, { key: "Delete" }] });

  using shiftSelect = new Tea(localClient(), () => undefined, { draft: "hello" });
  shiftSelect.handle({
    kind: "input_events",
    events: [{ key: "ArrowLeft", shift: true }, { key: "ArrowLeft", shift: true }, { key: "x" }],
  });

  const markPosted: PaintDownMessage[] = [];
  using markTea = new Tea(localClient(), (batch) => markPosted.push(...batch), { draft: "hello" });
  markTea.handle({ kind: "input_events", events: [{ key: "ComposerCaret:5:0" }] });
  await Promise.resolve();

  expect({
    afterCaret: { ...tea.draft },
    typed: { ...typed.draft },
    backspaced: { ...backspaced.draft },
    deleted: { ...deleted.draft },
    shiftSelect: { ...shiftSelect.draft },
    replicaMark: replicaOf(markPosted),
  }).toEqual({
    afterCaret: { draft: "hello", cursor: 5, mark: 0 },
    typed: { draft: "x", cursor: 1, mark: null },
    backspaced: { draft: "", cursor: 0, mark: null },
    deleted: { draft: "", cursor: 0, mark: null },
    shiftSelect: { draft: "helx", cursor: 4, mark: null },
    replicaMark: { draft: "hello", cursor: 5, mark: 0 },
  });
});

test("Tea Esc collapses a range and does not arm unwind", () => {
  using selected = new Tea(localClient(), () => undefined, { draft: "hello" });
  selected.handle({ kind: "input_events", events: [{ key: "ComposerCaret:5:0" }] });
  selected.handle({ kind: "input_events", events: [{ key: "Escape" }] });

  using idle = new Tea(localClient(), () => undefined, { draft: "hello" });
  idle.handle({ kind: "input_events", events: [{ key: "Escape" }] });

  expect({
    selected: { ...selected.draft, armed: selected.escClearArmed },
    idleArmed: idle.escClearArmed,
  }).toEqual({
    selected: { draft: "hello", cursor: 5, mark: null, armed: false },
    idleArmed: true,
  });
});
