import { autorun, when } from "mobx";
import { describe, expect, it } from "vitest";

import { ObservableAbortSignal } from "../observable-abort-signal.js";

describe("ObservableAbortSignal", () => {
  it("is the same AbortSignal; aborted tracks; when and fetch see it", async () => {
    const ac = new AbortController();
    const signal = ObservableAbortSignal.from(ac.signal);
    const again = ObservableAbortSignal.from(signal);
    const seen: boolean[] = [];
    const stop = autorun(() => {
      seen.push(signal.aborted);
    });
    let n = 0;
    const stopCount = autorun(() => {
      void signal.aborted;
      n += 1;
    });
    ac.abort("nope");
    const already = ObservableAbortSignal.abort("x");
    await when(() => already.aborted);
    const text = await (
      await fetch("data:text/plain,ok", { signal: ObservableAbortSignal.from(new AbortController().signal) })
    ).text();
    stop();
    stopCount();
    expect({
      identity:
        signal === ac.signal &&
        signal instanceof AbortSignal &&
        signal instanceof ObservableAbortSignal &&
        again === signal,
      abort: { aborted: signal.aborted, reason: signal.reason, seen },
      notify: n,
      already: { aborted: already.aborted, reason: already.reason },
      fetch: text,
    }).toEqual({
      identity: true,
      abort: { aborted: true, reason: "nope", seen: [false, true] },
      notify: 2,
      already: { aborted: true, reason: "x" },
      fetch: "ok",
    });
  });
});
