import { describe, expect, it } from "vitest";

import { describeHttpFailure, wrapFetchFailure } from "../fetch-failure.js";
import { REQUEST_TIMEOUT_MS } from "../request-timeout.js";

describe("fetch failure line", () => {
  it("names why+url+cause; skips the undici wrapper", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
    const undici = new TypeError("fetch failed", { cause });
    const url = "http://127.0.0.1:11434/v1/models";
    const probe = { why: "models probe", method: "GET", url } as const;
    const wrapped = wrapFetchFailure(undici, probe);
    const completion401 = describeHttpFailure({
      why: "completion",
      method: "POST",
      url: "https://api.x.ai/v1/chat/completions",
      status: 401,
      detail: "nope",
    });
    expect({
      bare: wrapFetchFailure(new TypeError("fetch failed"), probe).message,
      http: completion401,
      wrapped: wrapped.message,
      causeIsUndici: wrapped.cause === undici,
      timeoutMs: REQUEST_TIMEOUT_MS,
    }).toEqual({
      bare: "models probe GET http://127.0.0.1:11434/v1/models: fetch failed",
      http: "completion POST https://api.x.ai/v1/chat/completions: HTTP 401 nope",
      wrapped: "models probe GET http://127.0.0.1:11434/v1/models: connect ECONNREFUSED 127.0.0.1:9",
      causeIsUndici: true,
      timeoutMs: 60_000,
    });
  });
});
