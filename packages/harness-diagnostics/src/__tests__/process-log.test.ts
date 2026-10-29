import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { debugEnabled, dumpSkipped, fail, mute, note, openLog, step, trace } from "../index.js";

const priorDebug = process.env.DEBUG;
const priorLog = process.env.HARNESS_LOG;

afterEach(() => {
  dumpSkipped(
    new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
  );
  if (priorDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = priorDebug;
  if (priorLog === undefined) delete process.env.HARNESS_LOG;
  else process.env.HARNESS_LOG = priorLog;
});

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), "harness-log-")), "injected.log");
}

describe("debugEnabled re-export", () => {
  it("follows DEBUG namespaces", () => {
    process.env.DEBUG = "harness:turn";
    expect(debugEnabled("harness:turn")).toBe(true);
    expect(debugEnabled("harness:paint")).toBe(false);
  });
});

describe("injected path", () => {
  it("openLog uses the caller path, not an SDK layout", () => {
    const path = tmpLog();
    delete process.env.HARNESS_LOG;
    expect(openLog(path)).toBe(path);
    expect(process.env.HARNESS_LOG).toBe(path);
    expect(openLog(join(path, "..", "other.log"))).toBe(path);
  });

  it("a log call writes through the injected path", () => {
    const path = tmpLog();
    delete process.env.HARNESS_LOG;
    process.env.DEBUG = "*";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    openLog(path);
    step("from-step");
    note("from-note");
    fail("from-fail");
    trace("harness:probe", "from-trace");
    stderr.mockRestore();
    const file = readFileSync(path, "utf8");
    expect(file).toMatch(/from-step/);
    expect(file).toMatch(/from-note/);
    expect(file).toMatch(/FAIL from-fail/);
    expect(file).toMatch(/harness:probe pid=\d+ from-trace/);
  });

  it("muted trace and step still append to the file", () => {
    const path = tmpLog();
    delete process.env.HARNESS_LOG;
    process.env.DEBUG = "*";
    openLog(path);
    mute();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    step("muted-step");
    trace("harness:probe", "muted-trace");
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
    const file = readFileSync(path, "utf8");
    expect(file).toMatch(/muted-step/);
    expect(file).toMatch(/muted-trace/);
    const dumped: string[] = [];
    dumpSkipped(
      new Writable({
        write(chunk, _enc, cb) {
          dumped.push(String(chunk));
          cb();
        },
      }),
    );
    expect(dumped.join("")).toMatch(/muted-step/);
    expect(dumped.join("")).toMatch(/muted-trace/);
  });
});
