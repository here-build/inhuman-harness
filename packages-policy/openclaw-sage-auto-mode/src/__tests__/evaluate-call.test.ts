import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BeforeToolCallEvent, Block, HookCtx, OpenClawApi } from "@inhuman.tools/policy-openclaw";
import { afterEach, describe, expect, it } from "vitest";

import plugin, { handle } from "../index.js";

describe("handle", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function api(config?: unknown): OpenClawApi {
    return {
      ...(config === undefined ? {} : { pluginConfig: config }),
      on() {
        return undefined;
      },
    };
  }

  async function allowProgram(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "policy-openclaw-sage-"));
    temps.push(dir);
    const file = path.join(dir, "authorize.scm");
    await writeFile(file, '"allow"\n');
    return file;
  }

  it("an empty configured sage key does not read SAGE_API_KEY", async () => {
    const blank = await handle(
      { toolName: "exec", params: { command: "git pull" } },
      api({ sageApiKey: "" }),
      {},
      { SAGE_API_KEY: "from-env" },
    );
    const whitespace = await handle(
      { toolName: "exec", params: { command: "git pull" } },
      api({ sageApiKey: "  " }),
      {},
      { SAGE_API_KEY: "from-env" },
    );
    expect({ blank, whitespace }).toEqual({
      blank: { block: true, blockReason: "not authorized" },
      whitespace: { block: true, blockReason: "not authorized" },
    });
  });

  it("a missing program file denies and does not run the dist script", async () => {
    const result = await handle(
      { toolName: "exec", params: { command: "git pull" } },
      api({ authorizationPath: "/no/such/policy-authorize.scm", sageApiKey: "test-key" }),
    );
    expect(result).toEqual({ block: true, blockReason: "not authorized" });
  });

  it("a user program allows without the model", async () => {
    const file = await allowProgram();
    const result = await handle(
      { toolName: "exec", params: { command: "git pull" } },
      api({ authorizationPath: file, sageApiKey: "test-key" }),
    );
    expect(result).toBeUndefined();
  });

  it("edit of .env is a floor block", async () => {
    const result = await handle(
      { toolName: "write", params: { path: ".env", content: "SECRET" } },
      api({ sageApiKey: "test-key" }),
    );
    expect(result).toEqual({ block: true, blockReason: "blocked by policy floor" });
  });

  it("the registered before_tool_call handler blocks a floor write", async () => {
    let matcher: readonly string[] | undefined;
    let handler:
      ((event: BeforeToolCallEvent, ctx: HookCtx) => Promise<Block | undefined> | Block | undefined) | undefined;
    plugin.register({
      on(hook, registered, options) {
        expect(hook).toBe("before_tool_call");
        matcher = options?.matcher;
        handler = registered;
      },
    });
    if (handler === undefined) throw new Error("policy-openclaw-sage did not register");
    const result = await handler({ toolName: "write", params: { path: ".env", content: "SECRET" } }, {});
    expect({ matcher, result }).toEqual({
      matcher: ["exec", "write", "edit", "apply_patch", "read"],
      result: { block: true, blockReason: "blocked by policy floor" },
    });
  });
});
