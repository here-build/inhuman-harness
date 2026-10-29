/**
 * A rejected background chore is logged, never an unhandled rejection —
 * the daemon's process log exits on those.
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { KernelDaemon } from "../KernelDaemon.js";

vi.mock("@inhuman.tools/plexus-expectations/executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@inhuman.tools/plexus-expectations/executor")>()),
  dropConnection: () => Promise.reject(new Error("drop failed")),
}));

describe("floating rejections", () => {
  it("connect/logout survives a rejected connection drop", async () => {
    const kernel = new KernelDaemon(await realpath(await mkdtemp(join(tmpdir(), "harness-float-"))));
    onTestFinished(() => kernel[Symbol.dispose]());
    await kernel.ready;
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    onTestFinished(() => {
      process.off("unhandledRejection", record);
    });
    const [id] = Object.keys(kernel.connections);
    expect(await kernel.handleRequest("connect/logout", { id })).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
  });
});
