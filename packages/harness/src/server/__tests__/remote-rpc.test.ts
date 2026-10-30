/** `remote/login`, `remote/status`, `remote/logout` over the kernel daemon, against a fake WorkOS on global fetch. */
import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";

async function open(): Promise<{ kernel: KernelDaemon; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-remote-")));
  const kernel = new KernelDaemon(root);
  await kernel.ready;
  onTestFinished(() => kernel[Symbol.dispose]());
  return { kernel, root };
}

function fakeWorkos(): void {
  vi.stubGlobal("fetch", (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/authorize/device")) {
      return Promise.resolve(
        Response.json({
          device_code: "dev-1",
          user_code: "AAAA-BBBB",
          verification_uri: "https://auth.example/device",
          verification_uri_complete: "https://auth.example/device?user_code=AAAA-BBBB",
          expires_in: 300,
          interval: 0,
        }),
      );
    }
    return Promise.resolve(
      Response.json({
        access_token: "a.e30.s",
        refresh_token: "r1",
        expires_in: 3600,
        user: { id: "user_1", email: "v@example.com" },
      }),
    );
  });
}

describe("remote/* over the kernel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("status is logged out with a stable machine id", async () => {
    const { kernel } = await open();
    const first = (await kernel.handleRequest("remote/status", {})) as { loggedIn: boolean; machineId: string };
    const second = (await kernel.handleRequest("remote/status", {})) as { machineId: string };
    expect(first).toMatchObject({ loggedIn: false, connected: false });
    expect(second.machineId).toBe(first.machineId);
  });

  it("login without a client id fails with a clear message", async () => {
    vi.stubEnv("HARNESS_REMOTE_WORKOS_CLIENT_ID", "");
    const { kernel } = await open();
    await expect(kernel.handleRequest("remote/login", {})).rejects.toThrow(/HARNESS_REMOTE_WORKOS_CLIENT_ID/);
  });

  it("login parks on open-url, stores tokens on resolve, logout drops them", async () => {
    vi.stubEnv("HARNESS_REMOTE_WORKOS_CLIENT_ID", "client_test");
    fakeWorkos();
    const { kernel, root } = await open();
    const parked = (await kernel.handleRequest("remote/login", { name: "Studio" })) as {
      form: string;
      pending: string;
      body: string;
    };
    expect(parked.form).toBe("ui");
    expect(parked.body).toContain("harness/open-url");
    expect(parked.body).toContain("https://auth.example/device?user_code=AAAA-BBBB");

    const done = (await kernel.handleRequest("ui/resolve", { pending: parked.pending, kind: "accept" })) as {
      ok: boolean;
      email: string;
      machineId: string;
    };
    expect(done).toMatchObject({ ok: true, email: "v@example.com" });

    const status = await kernel.handleRequest("remote/status", {});
    expect(status).toMatchObject({
      loggedIn: true,
      email: "v@example.com",
      machineId: done.machineId,
      machineName: "Studio",
      connected: false,
    });
    const file = join(root, "secrets.json");
    expect(JSON.parse(await readFile(file, "utf8")).connections["remote:tokens"].refreshToken).toBe("r1");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    expect(await kernel.handleRequest("remote/logout", {})).toEqual({ ok: true, wasLoggedIn: true });
    expect(await kernel.handleRequest("remote/status", {})).toMatchObject({
      loggedIn: false,
      machineId: done.machineId,
    });
  });

  it("cancelling the open-url form answers ok:false", async () => {
    vi.stubEnv("HARNESS_REMOTE_WORKOS_CLIENT_ID", "client_test");
    fakeWorkos();
    const { kernel } = await open();
    const parked = (await kernel.handleRequest("remote/login", {})) as { pending: string };
    expect(await kernel.handleRequest("ui/resolve", { pending: parked.pending, kind: "cancel" })).toEqual({
      ok: false,
    });
    expect(await kernel.handleRequest("remote/status", {})).toMatchObject({ loggedIn: false });
  });
});
