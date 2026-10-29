import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import plugin, {
  authorizeOperands,
  handle,
  MATCHED_TOOLS,
  operands,
  type BeforeToolCallEvent,
  type Block,
  type DecisionValue,
  type HookCtx,
  type OpenClawApi,
} from "../index.js";

describe("operands: read and path preparation", () => {
  it("a read is matched and its secret path is a floor block", async () => {
    expect(MATCHED_TOOLS).toContain("read");
    expect(operands({ toolName: "read", params: { path: "src/../.env" } })).toEqual({
      kind: "calls",
      calls: [{ kind: "read", path: "src/../.env" }],
    });
    const vote = vi.fn(async () => "allow" as const);
    expect(await authorizeOperands([{ kind: "read", path: "src/../.env" }], vote)).toEqual({
      block: true,
      blockReason: "blocked by policy floor",
    });
    expect(await authorizeOperands([{ kind: "write", path: ".GIT/hooks/pre-commit" }], vote)).toEqual({
      block: true,
      blockReason: "blocked by policy floor",
    });
    expect(vote).not.toHaveBeenCalled();
  });
});

describe("handle", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function api(evaluate?: (document: string) => DecisionValue | Promise<DecisionValue>, config?: unknown): OpenClawApi {
    return {
      ...(config === undefined ? {} : { pluginConfig: config }),
      ...(evaluate === undefined
        ? {}
        : {
            runtime: {
              decisions: {
                evaluate: async (input) => evaluate(input.document),
              },
            },
          }),
      on() {
        return undefined;
      },
    };
  }

  it("blocks a floor block and does not ask the decision runtime", async () => {
    const evaluate = vi.fn((_document: string) => ({ value: "allow" }) as const);
    const result = await handle({ toolName: "write", params: { path: ".env", content: "SECRET" } }, api(evaluate));
    expect(evaluate).not.toHaveBeenCalled();
    expect(result).toEqual({ block: true, blockReason: "blocked by policy floor" });
  });

  it("an allow vote lifts a floor deny", async () => {
    const result = await handle(
      { toolName: "exec", params: { command: "sudo ls" } },
      api(() => ({ value: "allow" })),
    );
    expect(result).toBeUndefined();
  });

  it("a thrown decision denies", async () => {
    const result = await handle(
      { toolName: "exec", params: { command: "git pull" } },
      api(() => {
        throw new Error("judge down");
      }),
    );
    expect(result).toEqual({ block: true, blockReason: "not authorized" });
  });

  it("sends the command, not a missing decision, for sudo ls", async () => {
    const evaluate = vi.fn((_document: string) => ({ value: "deny" }) as const);
    const result = await handle({ toolName: "exec", params: { command: "sudo ls" } }, api(evaluate));
    expect(evaluate).toHaveBeenCalledWith("sudo ls");
    expect(result).toEqual({ block: true, blockReason: "not authorized" });
  });

  it("leaves code-mode exec to the host", async () => {
    const evaluate = vi.fn((_document: string) => ({ value: "deny" }) as const);
    const event: BeforeToolCallEvent = {
      toolName: "exec",
      toolKind: "code_mode_exec",
      params: { command: "sudo ls" },
    };
    expect(await handle(event, api(evaluate))).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("blocks a known tool with no operand", async () => {
    expect(await handle({ toolName: "exec", params: {} }, api())).toEqual({
      block: true,
      blockReason: "missing command or path",
    });
    expect(await handle({ toolName: "apply_patch", params: { input: "diff" } }, api())).toEqual({
      block: true,
      blockReason: "missing command or path",
    });
  });

  it("edit reads file_path and still floor-blocks .env", async () => {
    const evaluate = vi.fn((_document: string) => ({ value: "allow" }) as const);
    const result = await handle({ toolName: "edit", params: { file_path: ".env" } }, api(evaluate));
    expect(evaluate).not.toHaveBeenCalled();
    expect(result).toEqual({ block: true, blockReason: "blocked by policy floor" });
  });

  it("a missing program file denies and does not run the dist script", async () => {
    const result = await handle(
      { toolName: "exec", params: { command: "git pull" } },
      api(undefined, { authorizationPath: "/no/such/policy-authorize.scm" }),
      {},
      {},
    );
    expect(result).toEqual({ block: true, blockReason: "not authorized" });
  });

  it("judges each apply_patch path and does not send the patch", async () => {
    const seen: string[] = [];
    const result = await handle(
      { toolName: "apply_patch", params: { input: "SECRET DIFF" }, derivedPaths: ["src/a.ts", ".env"] },
      api((document) => {
        seen.push(document);
        return { value: "allow" };
      }),
    );
    expect(seen).toEqual(["src/a.ts"]);
    expect(result).toEqual({ block: true, blockReason: "blocked by policy floor" });
  });

  it("a disabled decision role falls through to a user program", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "policy-openclaw-"));
    temps.push(dir);
    const file = path.join(dir, "authorize.scm");
    await writeFile(file, '"allow"\n');
    const result = await handle(
      { toolName: "exec", params: { command: "git pull" } },
      api(async () => ({ unavailable: true, reason: "disabled" }), { authorizationPath: file }),
    );
    expect(result).toBeUndefined();
  });

  it("a deadline does not fall through", async () => {
    const result = await handle(
      { toolName: "exec", params: { command: "git pull" } },
      api(async () => ({ unavailable: true, reason: "deadline" })),
    );
    expect(result).toEqual({ block: true, blockReason: "not authorized" });
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
    if (handler === undefined) throw new Error("policy-openclaw did not register");
    const result = await handler({ toolName: "write", params: { path: ".env", content: "SECRET" } }, {});
    expect({ matcher, result }).toEqual({
      matcher: ["exec", "write", "edit", "apply_patch", "read"],
      result: { block: true, blockReason: "blocked by policy floor" },
    });
  });
});

describe("handle: host llm judge", () => {
  type Input = Parameters<NonNullable<NonNullable<OpenClawApi["runtime"]>["llm"]>["complete"]>[0];
  const temps: string[] = [];

  afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const run = async (complete: (input: Input) => Promise<{ text: string }>) => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-judge-"));
    temps.push(dir);
    const file = path.join(dir, "authorize.scm");
    await writeFile(file, '(if (equal? (decide/yesno "Is this tool call safe?") "yes") "allow" "deny")\n');
    return handle(
      { toolName: "exec", params: { command: "git pull" } },
      { pluginConfig: { authorizationPath: file }, runtime: { llm: { complete } }, on: () => undefined },
    );
  };

  it("sends the judge prompt as messages, not the raw document", async () => {
    const seen: Input[] = [];
    await run(async (input) => {
      seen.push(input);
      return { text: '{"value":"yes"}' };
    });
    expect(seen).toHaveLength(1);
    const input = seen[0]!;
    expect(input).not.toHaveProperty("document");
    expect(input.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(input.messages[1]!.content).toContain("Is this tool call safe?");
    expect(input.responseFormat).toMatchObject({ type: "json_schema" });
    expect(input.purpose).toBe("policy judge");
  });

  it("allows on a yes answer", async () => {
    expect(await run(async () => ({ text: '{"value":"yes"}' }))).toBeUndefined();
  });

  it("denies on a no answer", async () => {
    expect(await run(async () => ({ text: '{"value":"no"}' }))).toEqual({
      block: true,
      blockReason: "not authorized",
    });
  });

  it("denies when the host throws", async () => {
    const result = await run(async () => {
      throw Object.assign(new Error("nope"), { code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    });
    expect(result).toMatchObject({ block: true });
  });

  it("allows a fenced json answer", async () => {
    expect(await run(async () => ({ text: '```json\n{"value":"yes"}\n```' }))).toBeUndefined();
  });
});
