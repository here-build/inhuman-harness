import { debugEnabled } from "@inhuman.tools/harness-diagnostics";
import { afterEach, describe, expect, it } from "vitest";

const priorDebug = process.env.DEBUG;
const priorLog = process.env.HARNESS_LOG;

afterEach(() => {
  if (priorDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = priorDebug;
  if (priorLog === undefined) delete process.env.HARNESS_LOG;
  else process.env.HARNESS_LOG = priorLog;
});

describe("debugEnabled re-export", () => {
  it("follows DEBUG namespaces", () => {
    process.env.DEBUG = "harness:turn";
    expect({
      turn: debugEnabled("harness:turn"),
      paint: debugEnabled("harness:paint"),
    }).toEqual({ turn: true, paint: false });
  });
});
