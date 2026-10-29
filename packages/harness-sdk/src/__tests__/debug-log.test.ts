import { debugEnabled, debugOn, trace } from "@inhuman.tools/harness-diagnostics";
import { afterEach, describe, expect, it } from "vitest";

const priorDebug = process.env.DEBUG;
const priorLog = process.env.HARNESS_LOG;

afterEach(() => {
  if (priorDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = priorDebug;
  if (priorLog === undefined) delete process.env.HARNESS_LOG;
  else process.env.HARNESS_LOG = priorLog;
});

describe("debugEnabled", () => {
  it("is off when DEBUG is unset and on when set empty", () => {
    delete process.env.DEBUG;
    expect(debugEnabled("harness:judge")).toBe(false);
    expect(debugOn()).toBe(false);
    process.env.DEBUG = "";
    expect(debugOn()).toBe(true);
    expect(debugEnabled("harness:judge")).toBe(true);
  });

  it("treats DEBUG=* and a bare set as every namespace", () => {
    process.env.DEBUG = "*";
    expect(debugEnabled("harness:judge")).toBe(true);
    process.env.DEBUG = "";
    expect(debugOn()).toBe(true);
    expect(debugEnabled("harness:paint")).toBe(true);
  });

  it("matches a name, its children, and a trailing star", () => {
    process.env.DEBUG = "harness:judge";
    expect(debugEnabled("harness:judge")).toBe(true);
    expect(debugEnabled("harness:judge:vote")).toBe(true);
    expect(debugEnabled("harness:paint")).toBe(false);
    process.env.DEBUG = "harness:*";
    expect(debugEnabled("harness:paint")).toBe(true);
    expect(debugEnabled("quickdraw:present")).toBe(false);
  });

  it("lets a skip win over a broader enable", () => {
    process.env.DEBUG = "*,-harness:paint";
    expect(debugEnabled("harness:judge")).toBe(true);
    expect(debugEnabled("harness:paint")).toBe(false);
    expect(debugEnabled("harness:paint:tick")).toBe(false);
  });

  it("does not format a disabled trace", () => {
    delete process.env.DEBUG;
    expect(() => trace("harness:judge", "plan")).not.toThrow();
  });
});
