import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import { describe, expect, it } from "vitest";

import { ensure, stop } from "../../../dist/server/ensure.js";

class Scratch implements AsyncDisposable {
  readonly root = realpathSync(mkdtempSync("/tmp/harness-ensure-"));

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await stop(this.root);
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}

function socketPids(socketPath: string): number[] {
  if (!existsSync(socketPath)) return [];
  try {
    const out = execFileSync("lsof", ["-t", socketPath], { encoding: "utf8", timeout: 5_000 }).trim();
    if (out === "") return [];
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

describe("ensure", () => {
  it("sock singleton: stale is not live; second ensure does not spawn; restart replaces; restart with no owner still spawns", async () => {
    await using scratch = new Scratch();
    const sock = daemonSocketPath(scratch.root);

    writeFileSync(sock, "");
    expect({ stale: socketPids(sock) }).toEqual({ stale: [] });

    await ensure(scratch.root);
    const first = socketPids(sock);
    expect({ live: first.length > 0 }).toEqual({ live: true });

    await ensure(scratch.root);
    expect({ pids: socketPids(sock) }).toEqual({ pids: first });

    await ensure(scratch.root, { restart: true });
    const replaced = socketPids(sock);
    expect({
      live: replaced.length > 0,
      replaced: replaced.join(",") !== first.join(","),
    }).toEqual({ live: true, replaced: true });

    await stop(scratch.root);
    expect({ pids: socketPids(sock) }).toEqual({ pids: [] });
    await ensure(scratch.root, { restart: true });
    expect({ live: socketPids(daemonSocketPath(scratch.root)).length > 0 }).toEqual({ live: true });
  }, 80_000);

  it("a spawned daemon exits once its kernel dir is removed", async () => {
    await using scratch = new Scratch();
    await ensure(scratch.root);
    const [pid] = socketPids(daemonSocketPath(scratch.root));
    rmSync(scratch.root, { recursive: true, force: true });
    const deadline = Date.now() + 15_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        process.kill(pid!, 0);
      } catch {
        alive = false;
      }
    }
    expect({ spawned: pid != null, alive }).toEqual({ spawned: true, alive: false });
  }, 30_000);

  it("omitted root is homedir/.harness", async () => {
    const home = realpathSync(mkdtempSync("/tmp/harness-ensure-home-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const root = join(home, ".harness");
    try {
      await ensure();
      const resolved = realpathSync(root);
      expect({
        underHome: resolved.startsWith(home),
        live: socketPids(daemonSocketPath(resolved)).length > 0,
      }).toEqual({ underHome: true, live: true });
      await stop(resolved);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      await stop(join(home, ".harness")).catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }, 80_000);
});
