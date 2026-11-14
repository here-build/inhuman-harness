import { publishKernelSeat } from "@inhuman.tools/harness-model";
import { runInAction } from "mobx";
import { expect, test } from "vitest";

import { liveSession, rounds, startTurn, wait } from "./fixtures/live-continuation.js";

test("an open turn keeps its provider request across last-client loss and regains the foreground budget", async () => {
  const live = await liveSession();
  const hub = live.kernel.doc.awareness;
  publishKernelSeat(hub, "s1");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const { turn } = await startTurn(live);
    live.model.reply({ text: "Done.", gate });
    const expectation = rounds(turn)[0]?.expectation;
    if (expectation == null) throw new Error("The first provider round was not admitted");
    await wait(() => expectation.retryForeground);
    expect(expectation.retryMaxAttempts).toBe(15);
    publishKernelSeat(hub, null);
    await wait(() => !expectation.retryForeground);
    expect(live.kernel.liveSession("s1")).toBe(live.session);
    expect(expectation.isDone).toBe(false);
    expect(rounds(turn)).toHaveLength(1);
    expect(expectation.retryBackgroundMaxAttempts).toBe(0);

    runInAction(() => {
      live.kernel.doc.root.retryMaxAttempts = 7;
    });
    publishKernelSeat(hub, "s1");
    await wait(() => expectation.retryForeground && expectation.retryMaxAttempts === 7);
    expect(live.kernel.liveSession("s1")).toBe(live.session);
    release();
    await wait(() => turn.reducerExited);
    expect(expectation.outcome).toBe("successful");
    publishKernelSeat(hub, null);
    await wait(() => live.kernel.liveSession("s1") == null);
  } finally {
    release();
  }
});
