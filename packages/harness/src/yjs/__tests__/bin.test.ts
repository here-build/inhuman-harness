import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { Hypervisor } from "@/hypervisor";
import { isExecutionReady, isSyncReady } from "@/protocol/supervision";

const bin = fileURLToPath(new URL("../../../dist/yjs/bin.js", import.meta.url));
const scratches: string[] = [];
const running: Hypervisor[] = [];

afterEach(async () => {
  for (const hv of running.splice(0)) {
    await hv.shutdown({ deadlineMs: 3_000 }).catch(() => undefined);
  }
  for (const root of scratches.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("yjs-server process bin", () => {
  it("publishes sync ready without claiming execution", async () => {
    expect(existsSync(bin)).toBe(true);
    const root = mkdtempSync("/tmp/harness-yjs-bin-");
    scratches.push(root);
    const hv = await Hypervisor.start({
      root,
      serverRoster: {
        servers: [
          {
            id: "yjs",
            role: "yjs",
            executable: process.execPath,
            args: [bin],
            requires: [],
            restart: { mode: "never", maxAttempts: 0, backoffMs: 0 },
          },
        ],
      },
      hypervisorId: "hv-yjs-bin",
      readyTimeoutMs: 8_000,
    });
    running.push(hv);
    expect(isSyncReady(hv.health())).toBe(true);
    expect(isExecutionReady(hv.health())).toBe(false);
    expect(hv.snapshot().map((child) => child.role)).toEqual(["yjs"]);
  });
});
