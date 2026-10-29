/**
 * The typed client against a real daemon on a real unix socket:
 * contract names, error codes and parks hold end to end.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarnessClient, HarnessRpcError } from "@inhuman.tools/harness-client";
import { connectUnixSocket } from "@inhuman.tools/harness-client/node";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import { describe, expect, it } from "vitest";

import { HarnessDaemon } from "../daemon/server/HarnessDaemon.js";

describe("harness-client against a daemon", () => {
  it("typed kernel and session calls, rpc errors, fall-through and a park, over the unix socket", async () => {
    const kernelRoot = realpathSync(mkdtempSync(join(tmpdir(), "harness-hc-kernel-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-hc-workspace-")));
    const daemon = new HarnessDaemon(kernelRoot);
    await daemon.listen();
    const socketPath = daemonSocketPath(kernelRoot);
    const forms: string[] = [];
    const kernelTransport = await connectUnixSocket({ socketPath, target: { host: "kernel" } });
    const kernel = createHarnessClient({
      transport: kernelTransport,
      onPark: (form) => {
        forms.push(form.body);
        // First the base URL, then the API key (skipped with an empty answer).
        return { kind: "text", input: forms.length === 1 ? "https://example.test/v1" : "" };
      },
    });
    const sessionTransport = await connectUnixSocket({
      socketPath,
      target: { host: "session", path: workspace, sessionId: "s1" },
    });
    const session = createHarnessClient({ transport: sessionTransport });
    try {
      const before = await kernel.kernel.connect.list({});
      expect(before.connections.map((row) => row.id)).toEqual(["web-keyless"]);

      // Typed errors keep the daemon's JSON-RPC code.
      const bad = await kernel.kernel.connect.get({ id: "nope" }).catch((error: unknown) => error);
      expect(bad).toBeInstanceOf(HarnessRpcError);
      expect(bad).toMatchObject({ code: -32_602 });
      const wrongHost = await kernel.session.kv.set({ key: "k", value: "v" }).catch((error: unknown) => error);
      expect(wrongHost).toMatchObject({ code: -32_601 });

      // A park is answered through onPark; the call resolves with the resumed result.
      const adopted = await kernel.kernel.connect.adopt({ driver: "openai-compat", name: "OpenAI-compatible" });
      expect(adopted).toEqual({ id: "example-test" });
      expect(forms).toHaveLength(2);

      // Session host, plus a kernel method reached through session fall-through.
      expect(await session.session.kv.set({ key: "theme", value: "dark" })).toEqual({ ok: true });
      const project = await daemon.project(workspace);
      expect(project.sessions.s1?.root.kvs.theme).toBe("dark");
      const listed = await session.kernel.connect.list({});
      expect(listed.connections.map((row) => row.id).sort()).toEqual(["example-test", "web-keyless"]);
    } finally {
      kernelTransport.close();
      sessionTransport.close();
      await daemon[Symbol.asyncDispose]();
      rmSync(kernelRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
