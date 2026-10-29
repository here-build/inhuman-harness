/**
 * PR-01b: headless N presents without throw (not an fps claim).
 */
import { describe, expect, it } from "vitest";

import { emitAnsi, type Buffer as CellBuffer } from "../../buffer/index.js";
import { createFpsTracker, LatestMailbox } from "../host.js";
import { init, update, type Model, type Msg } from "../model.js";
import type { Snapshot } from "../tea.js";
import { paint } from "../view.js";

function runHeadless(frames: number): { lastGen: number; frames: number } {
  let model = init(40, 12);
  let gen = 0;
  const mailbox = new LatestMailbox<Model>();
  const fps = createFpsTracker();
  let prev: CellBuffer | null = null;
  let canvas: CellBuffer | undefined;

  const publish = () => {
    gen += 1;
    const snap: Snapshot<Model> = { gen, model, at: performance.now() };
    mailbox.push(snap);
  };

  publish();

  for (let i = 0; i < frames; i++) {
    const msg: Msg = i % 7 === 0 ? { type: "key", key: "j" } : { type: "tick", now: Date.now() + i };
    model = update(msg, model);
    publish();

    const snap = mailbox.peek();
    if (!snap) continue;
    fps.addDropped(mailbox.takeDropped());
    fps.setGen(snap.gen);
    canvas = paint(snap.model, fps.sample(), canvas);
    const ansi = emitAnsi(prev, canvas, { forceFull: prev === null });
    // touch ansi so emit is exercised
    void ansi.length;
    prev = canvas ? { ...canvas, cells: canvas.cells.map((c) => ({ ...c, style: { ...c.style } })) } : null;
    fps.recordPresent(0.5);
  }

  return { lastGen: gen, frames };
}

describe("headless present smoke", () => {
  it("runs N update+paint cycles without throw", () => {
    const r = runHeadless(60);
    expect(r.lastGen).toBeGreaterThan(50);
    expect(r.frames).toBe(60);
  });
});
