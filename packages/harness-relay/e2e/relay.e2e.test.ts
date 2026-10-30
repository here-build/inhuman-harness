/**
 * The whole chain with real processes: `wrangler dev`, a daemon, a browser-like client.
 * Run: `pnpm --filter @inhuman.tools/harness-relay test:e2e` (needs the built cli, relay and web app).
 * Scenarios are ordered; the daemon is restarted and stopped near the end.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { KernelPlexus, SessionPlexus } from "@inhuman.tools/harness-peer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Browser, type Room } from "./browser.js";
import { OWNER, STRANGER, startStack, until, webClientDir, type Stack } from "./stack.js";

let stack: Stack;
let owner: Browser;
let machineId = "";
let sessionId = "";

beforeAll(async () => {
  stack = await startStack();
  // A 2 MiB blob in the kernel's bucket, written before the daemon boots.
  const bytes = randomBytes(2 * 1024 * 1024);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const dir = join(stack.kernel, "blobs", "sha256", hex.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hex), bytes);
  blob = { hex, bytes };
  for (const who of ["a", "b"] as const) putBlob(`client ${who}`, who);
  await stack.startDaemon();
  owner = await Browser.login(stack.base, OWNER);
});

afterAll(async () => {
  // A failed beforeAll leaves these unset.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  owner?.close();
  await stack?.stop();
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
});

let blob: { hex: string; bytes: Buffer };
const small = {} as Record<"a" | "b", { hex: string; text: string }>;

function putBlob(text: string, who: "a" | "b"): void {
  const bytes = Buffer.from(text);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const dir = join(stack.kernel, "blobs", "sha256", hex.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hex), bytes);
  small[who] = { hex, text };
}

/** Print the processes' output when a scenario fails. */
async function scenario<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(stack.logs());
    throw error;
  }
}

describe("relay chain", () => {
  it("1. the machine shows up online", () =>
    scenario(async () => {
      const found = await until("machine online", async () => {
        const list = await owner.machines();
        return list.find((m) => m.online);
      });
      machineId = found.machineId;
      expect(found.name).not.toBe("");
    }));

  it("2. kernel room syncs with content and answers JSON-RPC", () =>
    scenario(async () => {
      const room = owner.room(machineId, "kernel", {}, "harness:kernel");
      await room.synced();
      const kernel = KernelPlexus.connect(room.doc);
      expect(Object.keys(kernel.root.plugins).length).toBeGreaterThan(0);
      const status = await room.call("remote/status");
      expect(status).toMatchObject({ loggedIn: true, email: OWNER.email, connected: true, machineId });
    }));

  it("3. a session room is created, answers RPC, and daemon-side document updates reach the client", () =>
    scenario(async () => {
      sessionId = randomUUID();
      const room = owner.room(machineId, "session", { sessionId, path: stack.project }, `harness:session:${sessionId}`);
      await room.synced();
      const plexus = SessionPlexus.connect(room.doc);
      expect(plexus.root.path).toBe(stack.project);
      let updates = 0;
      room.doc.on("update", () => (updates += 1));
      const result = await room.call("eval", { requestId: randomUUID(), expr: "(+ 1 2)", policy: "auto" });
      expect(result).toMatchObject({ ok: true });
      // The program's turn is written by the daemon and arrives as a Yjs update.
      await until("daemon update", () => updates > 0);
    }));

  it("4. two clients in one room get their own responses", () =>
    scenario(async () => {
      const a = owner.room(machineId, "session", { sessionId, path: stack.project }, `harness:session:${sessionId}`);
      const b = owner.room(machineId, "session", { sessionId, path: stack.project }, `harness:session:${sessionId}`);
      await Promise.all([a.synced(), b.synced()]);
      // Both clients number their calls from 1; the relay's client tag keeps the answers apart.
      const read = async (room: Room, hex: string) => (await room.call("blob/get", { sha256: hex })).text as string;
      const calls: Array<[Room, "a" | "b"]> = Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? [a, "a"] : [b, "b"]));
      const answers = await Promise.all(calls.map(([room, who]) => read(room, small[who].hex)));
      expect(answers).toEqual(calls.map(([, who]) => small[who].text));
    }));

  it("5. a response over 1 MiB arrives intact", () =>
    scenario(async () => {
      const room = owner.room(machineId, "session", { sessionId, path: stack.project }, `harness:session:${sessionId}`);
      await room.synced();
      const got = await room.call("blob/get", { sha256: blob.hex });
      expect(got.bytes).toBe(blob.bytes.length);
      expect(Buffer.from(got.bytesBase64, "base64").equals(blob.bytes)).toBe(true);
    }));

  it("6. the app is served under /m/<id>/app/ with cache headers", () =>
    scenario(async () => {
      const index = await owner.fetch(`/m/${machineId}/app/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      const html = await index.text();
      expect(html).toBe(await (await import("node:fs/promises")).readFile(join(webClientDir, "index.html"), "utf8"));
      const asset = readdirSync(join(webClientDir, "assets")).find((f) => f.endsWith(".js"))!;
      const res = await owner.fetch(`/m/${machineId}/app/assets/${asset}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
      const redirect = await owner.fetch(`/m/${machineId}/app`);
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get("location")).toBe(`/m/${machineId}/app/`);
    }));

  it("7. /file serves project files and refuses paths outside the project roots", () =>
    scenario(async () => {
      const ok = await owner.fetch(`/m/${machineId}/file?path=${encodeURIComponent(join(stack.project, "hello.txt"))}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello from the project\n");
      for (const outside of [join(stack.dir, "outside.txt"), join(stack.project, "..", "outside.txt"), "/etc/passwd"]) {
        const res = await owner.fetch(`/m/${machineId}/file?path=${encodeURIComponent(outside)}`);
        expect(res.status, outside).toBe(404);
      }
    }));

  it("10. another user cannot see or reach the machine", () =>
    scenario(async () => {
      const stranger = await Browser.login(stack.base, STRANGER);
      try {
        expect(await stranger.machines()).toEqual([]);
        expect((await stranger.fetch(`/m/${machineId}/app/`)).status).toBe(404);
        expect(
          (await stranger.fetch(`/m/${machineId}/file?path=${encodeURIComponent(join(stack.project, "hello.txt"))}`))
            .status,
        ).toBe(404);
        const room = stranger.room(machineId, "kernel", {}, "harness:kernel");
        await expect(room.synced(3_000)).rejects.toThrow();
        // No cookie at all.
        expect((await fetch(`${stack.base}/m/${machineId}/app/`)).status).toBe(401);
        // The dev cookie of a wrong secret is not a login.
        await expect(Browser.login(stack.base, STRANGER, "wrong")).rejects.toThrow();
      } finally {
        stranger.close();
      }
    }));

  it("8. daemon restart: the client goes offline, then recovers and resyncs", () =>
    scenario(async () => {
      const room = owner.room(machineId, "kernel", {}, "harness:kernel");
      await room.synced();
      await stack.stopDaemon();
      await until("client sees the drop", () => !room.provider.wsconnected);
      await stack.startDaemon();
      await until("client reconnects", () => room.provider.wsconnected && room.provider.synced, 60_000);
      expect(await room.call("remote/status")).toMatchObject({ loggedIn: true, connected: true, machineId });
      // The daemon's room socket dropped (4504), or the relay already knew the machine was gone (4503).
      expect([4503, 4504]).toContain(room.closes[0]?.code);
      expect(room.statuses).toContain("disconnected");
      const file = await owner.fetch(
        `/m/${machineId}/file?path=${encodeURIComponent(join(stack.project, "hello.txt"))}`,
      );
      expect(file.status).toBe(200);
    }));

  it("9. with no control socket, rooms close 4503 and /app/ answers 503", () =>
    scenario(async () => {
      await stack.stopDaemon();
      await until("relay sees the machine offline", async () => {
        const list = await owner.machines();
        return list.find((m) => m.machineId === machineId)?.online === false;
      });
      const room = owner.room(machineId, "kernel", {}, "harness:kernel");
      await until("4503", () => room.closes.some((c) => c.code === 4503), 30_000);
      expect((await owner.fetch(`/m/${machineId}/app/`)).status).toBe(503);
      expect(existsSync(stack.kernel)).toBe(true);
    }));
});
