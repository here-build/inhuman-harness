import { expect, test } from "vitest";

import { LatestMailbox, createFpsTracker } from "../host.js";

test("LatestMailbox latest-wins + fps sample", () => {
  const box = new LatestMailbox<{ n: number }>();
  box.push({ gen: 1, model: { n: 1 }, at: 0 }, { gen: 2, model: { n: 2 }, at: 1 }, { gen: 3, model: { n: 3 }, at: 2 });
  expect({
    peek: box.peek(),
    dropped: box.takeDropped(),
    droppedAgain: box.takeDropped(),
  }).toEqual({
    peek: { gen: 3, model: { n: 3 }, at: 2 },
    dropped: 2,
    droppedAgain: 0,
  });

  box.push({ gen: 1, model: { n: 0 }, at: 3 });
  expect({ peek: box.peek(), dropped: box.takeDropped() }).toEqual({
    peek: { gen: 3, model: { n: 3 }, at: 2 },
    dropped: 0,
  });

  const fps = createFpsTracker();
  fps.setGen(9);
  fps.addDropped(2);
  fps.recordPresent(1.5);
  expect(fps.sample()).toMatchObject({
    lastGen: 9,
    snapshotsDropped: 2,
    frameMs: 1.5,
  });
});
