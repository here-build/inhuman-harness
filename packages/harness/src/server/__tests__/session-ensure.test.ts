import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { dumpSkipped, mute } from "@inhuman.tools/harness-diagnostics";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { mkdtemp, writeFile } from "fs-extra";
import { describe, expect, it } from "vitest";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";

const require = createRequire(import.meta.url);
const DRIVER_HREF = pathToFileURL(require.resolve("@inhuman.tools/plexus-expectations/driver")).href;

async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("session ensure", () => {
  it("failed ensure is sticky; a face flip does not unhandle", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const system = await mkdtemp(join(tmpdir(), "harness-ensure-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-ensure-p-"));
    await writeFile(
      join(system, "boom-driver.mjs"),
      `import { PEWDriver } from ${JSON.stringify(DRIVER_HREF)};
export default class BoomConnection extends PEWDriver {
  async bootstrap() {
    throw new Error("openai-compat timeout after 2500ms: https://example.test/v1/models");
  }
  resolve() {
    throw new Error("not used");
  }
}
`,
    );
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const driver = new DriverSpec({
      name: "boom",
      description: "boom",
      importPath: "./boom-driver.mjs",
      abilityClaim: ["completion"],
      multiplicity: "add-by-default",
    });
    kernel.plexus.root.drivers = { ...kernel.plexus.root.drivers, boom: driver };
    kernel.plexus.root.connections = { boom: new ConnectionSpec({ driver, name: "boom" }) };
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;

    try {
      mute();
      const session = await project.session("s1");
      void session.orchestrator.ensure("boom");
      await waitFor(
        () =>
          kernel.plexus.root.connections.boom?.readyState === "failed" &&
          /timeout after 2500ms/.test(kernel.plexus.root.connections.boom.error),
      );
      kernel.plexus.root.connections = {
        ...kernel.plexus.root.connections,
        boom2: new ConnectionSpec({ driver, name: "boom2" }),
      };
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect({
        readyState: kernel.plexus.root.connections.boom?.readyState,
        error: kernel.plexus.root.connections.boom?.error,
        unhandled: seen,
      }).toEqual({
        readyState: "failed",
        error: expect.stringMatching(/timeout after 2500ms/),
        unhandled: [],
      });
      session[Symbol.dispose]();
    } finally {
      dumpSkipped(
        new Writable({
          write(_chunk, _enc, cb) {
            cb();
          },
        }),
      );
      process.off("unhandledRejection", onUnhandled);
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    }
  });
});
