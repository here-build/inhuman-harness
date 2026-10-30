/** The connector's lifecycle as the kernel drives it: boot while logged in, status, logout. */
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { writeConnectionSecrets } from "../../../secrets.js";
import { KernelDaemon } from "../KernelDaemon.js";
import { REMOTE_TOKENS_ID } from "../remote-access.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function until(fn: () => Promise<boolean>, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("connects at boot when logged in, reports connected, and logout drops the socket", async () => {
  const auth: Array<string | undefined> = [];
  let drops = 0;
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    auth.push(req.headers.authorization);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("close", () => (drops += 1)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const client of wss.clients) client.terminate();
    server.close();
  });
  const previous = process.env["HARNESS_REMOTE_URL"];
  process.env["HARNESS_REMOTE_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    if (previous === undefined) delete process.env["HARNESS_REMOTE_URL"];
    else process.env["HARNESS_REMOTE_URL"] = previous;
  });

  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-remote-life-")));
  writeConnectionSecrets(root, REMOTE_TOKENS_ID, {
    apiKey: "tok-1",
    refreshToken: "refresh-1",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    email: "v@example.com",
  });

  using kernel = new KernelDaemon(root);
  await kernel.ready;
  const status = () => kernel.handleRequest("remote/status", {}) as Promise<{ connected: boolean; loggedIn: boolean }>;
  await until(async () => (await status()).connected, "connected");
  expect(auth).toEqual(["Bearer tok-1"]);
  expect(await status()).toMatchObject({ loggedIn: true, connected: true });

  await kernel.handleRequest("remote/logout", {});
  expect(await status()).toMatchObject({ loggedIn: false, connected: false });
  await until(() => Promise.resolve(drops === 1), "control socket closed");
});
