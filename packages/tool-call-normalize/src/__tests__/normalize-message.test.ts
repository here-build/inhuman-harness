import dedent from "dedent";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureBuiltins, LONGCAT_NAME_ALIASES, normalizeMessage } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";

describe("normalizeMessage", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("pass-through openai tool_calls preserves ids", () => {
    const r = normalizeMessage(
      {
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a"}' },
          },
        ],
      },
      { mode: "pass" },
    );
    expect(r.tool_calls[0]!.id).toBe("call_abc");
    expect(r.tool_calls[0]!.function.name).toBe("read_file");
  });

  it("recovers hermes tool_call JSON", () => {
    const r = normalizeMessage(
      dedent`
        I'll look it up.
        <tool_call>
        {"name": "get_weather", "arguments": {"city": "SF"}}
        </tool_call>
      `,
      { dialect: "hermes" },
    );
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["get_weather"]);
    expect(JSON.parse(r.tool_calls[0]!.function.arguments)).toEqual({
      city: "SF",
    });
    expect(r.content).toContain("look");
    expect(r.content).not.toContain("tool_call");
    expect(r.meta.estimated).toBe(true);
    expect(r.finish_reason).toBe("tool_calls");
  });

  it("recovers longcat argkey XML (screenshot form)", () => {
    const r = normalizeMessage(
      dedent`
      I'll create a large test file for you.<longcattoolcall>writefile
      <longcatargkey>path</longcatargkey>
      <longcatargvalue>largetestscript.py</longcatargvalue>
      <longcatargkey>content</longcatargkey>
      <longcatargvalue>"""doc"""
      import os
      </longcatargvalue>
      </longcattoolcall>
    `,
      {
        dialect: "longcat",
        nameAliases: LONGCAT_NAME_ALIASES,
      },
    );
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["write_file"]);
    const args = JSON.parse(r.tool_calls[0]!.function.arguments) as {
      path: string;
      content: string;
    };
    expect(args.path).toBe("largetestscript.py");
    expect(args.content).toContain("import os");
    expect(r.content).toBe("I'll create a large test file for you.");
  });

  it("auto-detects longcat from markers", () => {
    const r = normalizeMessage(
      `hi<longcat_tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</longcat_tool_call>`,
      { nameAliases: LONGCAT_NAME_ALIASES },
    );
    expect(r.meta.dialect).toBe("longcat");
    expect(r.tool_calls[0]!.function.name).toBe("read_file");
  });

  it("recovers qwen_xml function= form", () => {
    const r = normalizeMessage(
      `Ok.
<tool_call>
<function=write_file>
<parameter=path>
x.py
</parameter>
<parameter=content>
print(1)
</parameter>
</function>
</tool_call>`,
      { dialect: "qwen_xml" },
    );
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["write_file"]);
    expect(JSON.parse(r.tool_calls[0]!.function.arguments)).toEqual({
      path: "x.py",
      content: "print(1)",
    });
  });

  it("does not treat bare JSON as tool without delimiter", () => {
    const r = normalizeMessage(`Here is an example: {"name": "Bingo", "arguments": {}}`, { dialect: "hermes" });
    expect(r.tool_calls).toHaveLength(0);
  });

  // Fence-family cases live in fixtures/fence/ — they run batch AND stream
  // there (split-invariance and parity pick them up as corpus), which the
  // hand-written blocks that used to sit here never did.

  it("strips think tags into reasoning", () => {
    const r = normalizeMessage(
      `<think>plan</think>answer
<tool_call>
{"name": "x", "arguments": {}}
</tool_call>`,
      { dialect: "hermes" },
    );
    expect(r.reasoning_content).toContain("plan");
    expect(r.content).not.toContain("<think>");
    expect(r.tool_calls).toHaveLength(1);
  });

  it("unterminated think closes at tool marker", () => {
    const r = normalizeMessage(
      `<think>still thinking
<tool_call>
{"name": "read_file", "arguments": {"path": "a"}}
</tool_call>`,
      { dialect: "hermes" },
    );
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["read_file"]);
  });

  it("preserves native tool ids under merge", () => {
    const r = normalizeMessage(
      {
        content: `also
<tool_call>
{"name": "other", "arguments": {}}
</tool_call>`,
        tool_calls: [
          {
            id: "native_1",
            type: "function",
            function: { name: "first", arguments: "{}" },
          },
        ],
      },
      { dialect: "hermes", nativePolicy: "merge" },
    );
    expect(r.tool_calls[0]!.id).toBe("native_1");
    expect(r.tool_calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not rewrite bash when no longcat aliases", () => {
    const r = normalizeMessage(
      {
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { mode: "repair" },
    );
    expect(r.tool_calls[0]!.function.name).toBe("bash");
  });

  it("strict without tools throws", () => {
    expect(() => normalizeMessage("hi", { mode: "strict" })).toThrow(/strict/);
  });

  it("finish_reason tool_calls when recovered", () => {
    const r = normalizeMessage(`<tool_call>{"name":"a","arguments":{}}</tool_call>`, {
      dialect: "hermes",
      finishReasonIn: "stop",
    });
    expect(r.finish_reason).toBe("tool_calls");
  });

  it("distinct object args do not dedup under merge", () => {
    const r = normalizeMessage(
      {
        content: `<tool_call>{"name":"read_file","arguments":{"path":"b.ts"}}</tool_call>`,
        tool_calls: [
          {
            id: "n1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"a.ts"}',
            },
          },
        ],
      },
      { dialect: "hermes", nativePolicy: "merge" },
    );
    expect(r.tool_calls).toHaveLength(2);
    const paths = r.tool_calls.map((t) => JSON.parse(t.function.arguments).path);
    expect(paths.sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("identical parallel recovered calls both survive", () => {
    const r = normalizeMessage(
      `<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>
<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>`,
      { dialect: "hermes" },
    );
    expect(r.tool_calls).toHaveLength(2);
    expect(r.tool_calls[0]!.id).not.toBe(r.tool_calls[1]!.id);
  });

  it("fenced code inside write content arg is preserved", () => {
    const raw = dedent`
      ok<longcattoolcall>writefile
      <longcatargkey>path</longcatargkey>
      <longcatargvalue>x.py</longcatargvalue>
      <longcatargkey>content</longcatargkey>
      <longcatargvalue># Doc

      \`\`\`python
      print(1)
      \`\`\`

      end</longcatargvalue>
      </longcattoolcall>
    `;
    const r = normalizeMessage(raw, { dialect: "longcat" });
    expect(r.tool_calls).toHaveLength(1);
    const args = JSON.parse(r.tool_calls[0]!.function.arguments) as {
      content: string;
    };
    expect(args.content).toContain("print(1)");
    expect(args.content).toContain("```python");
  });

  it("partial marks only recovered truncated call, not native", () => {
    const r = normalizeMessage(
      {
        content: `<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>
<tool_call>{"name":"other","arguments":{"x":`,
        tool_calls: [
          {
            id: "n1",
            type: "function",
            function: { name: "native_ok", arguments: "{}" },
          },
        ],
      },
      { dialect: "hermes", nativePolicy: "merge" },
    );
    // native preserved
    expect(r.tool_calls.some((t) => t.id === "n1")).toBe(true);
    // partial indices must not include the native
    for (const pi of r.meta.partial) {
      expect(r.tool_calls[pi]!.id).not.toBe("n1");
    }
  });

  it("closed call + prose literal <tool_call> is not partial", () => {
    const r = normalizeMessage(
      `done
<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>
Note: models emit <tool_call> tags.`,
      { dialect: "hermes" },
    );
    expect(r.tool_calls).toHaveLength(1);
    expect(r.meta.partial).toHaveLength(0);
  });

  it("argAliases apply to JSON-form longcat", () => {
    const r = normalizeMessage(
      `<longcat_tool_call>{"name":"writefile","arguments":{"file_path":"a.py","text":"x"}}</longcat_tool_call>`,
      { dialect: "longcat" },
    );
    expect(r.tool_calls[0]!.function.name).toBe("write_file");
    const args = JSON.parse(r.tool_calls[0]!.function.arguments) as Record<string, string>;
    // LONGCAT_ARG_ALIASES: file_path→path, text→content
    expect(args.path).toBe("a.py");
    expect(args.content).toBe("x");
    expect(args.file_path).toBeUndefined();
  });

  it("wrong modelHint falls back to auto when extract empty", () => {
    const r = normalizeMessage(`hi\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>`, {
      modelHint: "longcat-flash",
    });
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["read_file"]);
    expect(r.meta.dialect).toBe("hermes");
  });

  it("unparseable JSON args dropped", () => {
    const r = normalizeMessage(`<tool_call>{"name":"a","arguments":"not json"}</tool_call>`, { dialect: "hermes" });
    expect(r.tool_calls).toHaveLength(0);
    expect(r.meta.dropped.some((d) => d.reason === "unparseable_args")).toBe(true);
  });

  it("nested tool markup inside fenced write content stays intact", () => {
    const raw = dedent`
      Writing docs.
      <longcat_tool_call>
      write_file
      <longcat_arg_key>path</longcat_arg_key><longcat_arg_value>d.md</longcat_arg_value>
      <longcat_arg_key>content</longcat_arg_key><longcat_arg_value># How tools work

      \`\`\`
      <longcat_tool_call>
      x
      </longcat_tool_call>
      \`\`\`

      Done.</longcat_arg_value>
      </longcat_tool_call>
      Saved.
    `;
    const r = normalizeMessage(raw, { dialect: "longcat" });
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["write_file"]);
    const args = JSON.parse(r.tool_calls[0]!.function.arguments) as {
      path: string;
      content: string;
    };
    expect(args.path).toBe("d.md");
    expect(args.content).toContain("<longcat_tool_call>");
    expect(args.content).toContain("Done.");
    expect(r.content).toContain("Saved");
  });

  it("openai modelHint does not auto-execute prose tool examples", () => {
    const r = normalizeMessage(
      'To call a tool you emit <tool_call>{"name":"read_file","arguments":{"path":"secret"}}</tool_call> like that.',
      { modelHint: "gpt-4o" },
    );
    expect(r.tool_calls).toHaveLength(0);
    expect(r.meta.dialect).toBe("openai");
  });

  it("unimplemented modelHint still recovers real hermes markup via auto", () => {
    const r = normalizeMessage(`<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>`, {
      modelHint: "mistral-large-latest",
    });
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["read_file"]);
  });

  it("mid-line fence open inside arg value is masked", () => {
    const raw = `<longcat_tool_call>
write_file
<longcat_arg_key>path</longcat_arg_key><longcat_arg_value>a.md</longcat_arg_value>
<longcat_arg_key>content</longcat_arg_key><longcat_arg_value>\`\`\`
<longcat_tool_call>
nested
</longcat_tool_call>
\`\`\`</longcat_arg_value>
</longcat_tool_call>`;
    const r = normalizeMessage(raw, { dialect: "longcat" });
    expect(r.tool_calls).toHaveLength(1);
    const args = JSON.parse(r.tool_calls[0]!.function.arguments) as {
      content: string;
    };
    expect(args.content).toContain("nested");
    expect(args.content).toContain("<longcat_tool_call>");
  });
});
