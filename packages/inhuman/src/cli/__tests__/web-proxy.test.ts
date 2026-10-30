import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessDaemon } from "@inhuman.tools/harness/testkit";
import { KERNEL_DOC_GUID, KernelPlexus } from "@inhuman.tools/harness-model";
import "@inhuman.tools/harness-model/register";
import { detachProtocolAwareness, waitForSync } from "@inhuman.tools/harness-peer";
import { Client } from "@inhuman.tools/harness-sdk";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import { listenWebApp } from "@inhuman.tools/harness-web-app/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

// The core ran these under its server project: 15 s, not the logic default.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("web-app proxy", () => {
  it("syncs the kernel through loopback and leaves the daemon on a unix socket", async () => {
    const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-web-proxy-")));
    temps.push(kernel);
    const daemon = new HarnessDaemon(kernel);
    await daemon.listen();
    const app = await listenWebApp({ sockPath: daemonSocketPath(kernel), port: 0 });
    const doc = new Y.Doc({ guid: KERNEL_DOC_GUID });
    const provider = new WebsocketProvider(`ws://127.0.0.1:${app.port}`, "kernel", doc, {
      disableBc: true,
      shouldReconnect: () => false,
    });
    provider.disconnectBc = () => undefined;
    detachProtocolAwareness(provider);
    try {
      await waitForSync(provider, "kernel", 8000);
      const plexus = KernelPlexus.connect(doc);
      expect(plexus.doc.guid).toBe(KERNEL_DOC_GUID);
      expect(daemon.server.endpoint()).toMatch(/daemon\.sock$/);
      await using unix = await Client.kernel(kernel);
      expect(unix.plexus.doc.guid).toBe(KERNEL_DOC_GUID);
      plexus.destroy();
    } finally {
      provider.destroy();
      doc.destroy();
      await app.close();
      await daemon[Symbol.asyncDispose]();
    }
  });

  it("serves a project file and refuses a path that leaves the root", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-web-file-")));
    temps.push(root);
    writeFileSync(join(root, "note.txt"), "hello");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "harness-web-outside-")));
    temps.push(outside);
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(join(outside, "secret.txt"), join(root, "linked.txt"));
    const app = await listenWebApp({ sockPath: join(root, "missing.sock"), port: 0, fileRoots: [root] });
    try {
      const ok = await fetch(`http://127.0.0.1:${app.port}/file?path=${encodeURIComponent(join(root, "note.txt"))}`);
      expect(ok.headers.get("x-harness-file")).toBe("1");
      expect(await ok.text()).toBe("hello");
      const escaped = await fetch(
        `http://127.0.0.1:${app.port}/file?path=${encodeURIComponent(join(outside, "secret.txt"))}`,
      );
      expect(escaped.status).toBe(404);
      const linked = await fetch(
        `http://127.0.0.1:${app.port}/file?path=${encodeURIComponent(join(root, "linked.txt"))}`,
      );
      expect(linked.status).toBe(404);
      const relative = await fetch(`http://127.0.0.1:${app.port}/file?path=note.txt`);
      expect(relative.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("refuses foreign and null origins with 403 and lets own or absent origins through to the proxy", async () => {
    const { request } = await import("node:http");
    const upgrade = (port: number, origin: string | undefined): Promise<string> =>
      new Promise((resolve) => {
        const headers: Record<string, string> = {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        };
        if (origin !== undefined) headers["Origin"] = origin;
        const req = request({ host: "127.0.0.1", port, path: "/kernel", headers });
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve("upgraded");
        });
        req.on("response", (res) => {
          resolve(String(res.statusCode));
          res.resume();
        });
        req.on("error", () => resolve("error"));
        req.end();
      });
    // The daemon socket is absent, so a request the origin check lets through dies at the proxy, not at 403.
    const missing = join(tmpdir(), `harness-web-origin-${Date.now()}.sock`);
    const app = await listenWebApp({ sockPath: missing, port: 0, extraOrigins: ["https://ok.example"] });
    try {
      expect(await upgrade(app.port, undefined)).not.toBe("403");
      expect(await upgrade(app.port, `http://127.0.0.1:${app.port}`)).not.toBe("403");
      expect(await upgrade(app.port, `http://localhost:${app.port}`)).not.toBe("403");
      expect(await upgrade(app.port, "https://ok.example")).not.toBe("403");
      expect(await upgrade(app.port, "https://evil.example")).toBe("403");
      expect(await upgrade(app.port, "null")).toBe("403");
      expect(await upgrade(app.port, `http://127.0.0.1:${app.port + 1}`)).toBe("403");
    } finally {
      await app.close();
    }
  });

  it("fails the upgrade when the daemon socket is missing", async () => {
    const missing = join(tmpdir(), `harness-web-missing-${Date.now()}.sock`);
    const app = await listenWebApp({ sockPath: missing, port: 0 });
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/kernel`);
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener("open", () => resolve("open"));
      socket.addEventListener("error", () => resolve("error"));
      socket.addEventListener("close", () => resolve("close"));
    });
    socket.close();
    await app.close();
    expect(outcome).not.toBe("open");
  });
});
