import { CompletionExpectation, CompletionJob, SystemToolJob } from "@inhuman.tools/harness-model";
import { describe, expect, it, vi } from "vitest";

import { createTurnResolvers, type TurnResolverHost } from "../turn-resolvers.js";

function fixture() {
  const host = {
    complete: vi.fn<TurnResolverHost["complete"]>(async (request) => {
      request.round.succeed("settled", "mock", "null", { result: { text: "Done." } });
      return { text: "Done." };
    }),
    join: vi.fn<TurnResolverHost["join"]>(async () => "settled"),
    compactHost: vi.fn<TurnResolverHost["compactHost"]>(() => {
      throw new Error("Unexpected compact");
    }),
  } satisfies TurnResolverHost;
  const job = new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "mock", model: "model" }) });
  const abort = new AbortController();
  return { host, job, abort, resolve: createTurnResolvers(host) };
}

describe("turn work resolution", () => {
  it("dispatches a completion with the turn signal and settles the node", async () => {
    const f = fixture();
    await f.resolve.completion(f.job, f.abort.signal);
    expect(f.host.complete).toHaveBeenCalledWith(
      expect.objectContaining({ round: f.job.expectation, signal: f.abort.signal }),
    );
    expect(f.job.expectation.responseText).toBe("Done.");
    expect(f.job.result).toEqual({ status: "fulfilled", value: "Done." });
  });

  it("does not dispatch already resolved work again", async () => {
    const f = fixture();
    await f.resolve.completion(f.job, f.abort.signal);
    await f.resolve.completion(f.job, f.abort.signal);
    expect(f.host.complete).toHaveBeenCalledOnce();
  });

  it("seals provider errors on the completion node", async () => {
    const f = fixture();
    f.host.complete.mockRejectedValueOnce(new Error("connection missing"));
    await f.resolve.completion(f.job, f.abort.signal);
    expect(f.job.expectation).toMatchObject({ outcome: "failed", endDetail: "connection missing" });
  });

  it("leaves cancellation settlement to the work owner", async () => {
    const f = fixture();
    f.host.complete.mockImplementationOnce(async () => {
      f.abort.abort("park");
      throw new Error("aborted");
    });
    await f.resolve.completion(f.job, f.abort.signal);
    expect(f.job.expectation.outcome).toBeNull();
  });

  it("delegates tool joins, including background release, to the work strategy", async () => {
    const f = fixture();
    const tool = new SystemToolJob({ name: "echo", background: true });
    f.host.join.mockResolvedValueOnce("aborted");
    expect(await f.resolve.work(tool, f.abort.signal)).toBe("aborted");
    expect(f.host.join).toHaveBeenCalledWith(tool, f.abort.signal);
    expect(tool.completed).toBe(false);
  });
});
