import dedent from "dedent";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureBuiltins, normalizeMessage } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { end, expectSequence, finish, runStream, start } from "./stream-harness.js";

describe("qwen bare <function=", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  const bare = dedent`
    Looking up.
    <function=read_file>
    <parameter=path>
    a.ts
    </parameter>
    </function>
  `;

  it("batch recovers bare function= form", () => {
    const r = normalizeMessage(bare, {
      dialect: "qwen_xml",
      tools: [{ name: "read_file" }],
    });
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["read_file"]);
    expect(JSON.parse(r.tool_calls[0]!.function.arguments)).toEqual({
      path: "a.ts",
    });
  });

  it("stream recovers bare function= form", async () => {
    expectSequence(
      await runStream([bare], {
        dialect: "qwen_xml",
        tools: [{ name: "read_file" }],
      }),
      [start("read_file"), end("read_file", { path: "a.ts" }), finish("tool_calls")],
    );
  });
});
