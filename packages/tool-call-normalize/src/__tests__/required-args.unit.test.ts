/**
 * A tool call missing a schema-required argument must never be
 * executable. Dialect-agnostic gate in normalize-message.ts, applied once
 * (both batch and stream assemble through the same spine) AFTER the schema
 * repair ladder (schema-repair.ts) has had its chance.
 */
import dedent from "dedent";
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins, normalizeMessage, type ToolDef, type MessageInput } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { end, expectSequence, runStream } from "./stream-harness.js";

const writeFile: ToolDef = {
  name: "write_file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

function nativeMessage(args: Record<string, unknown>): MessageInput {
  return {
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "write_file", arguments: JSON.stringify(args) },
      },
    ],
  };
}

describe("required-argument executability gate", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  describe("normalizeMessage — batch, native tool_calls", () => {
    it("required present -> executable, not partial", () => {
      const r = normalizeMessage(nativeMessage({ path: "a.ts", content: "hi" }), { tools: [writeFile] });
      expect(r.meta.partial).toEqual([]);
      expect(JSON.parse(r.tool_calls[0]!.function.arguments)).toEqual({
        path: "a.ts",
        content: "hi",
      });
    });

    it("required missing -> marked partial, args blanked so it can't execute", () => {
      const r = normalizeMessage(nativeMessage({ path: "a.ts" }), {
        tools: [writeFile],
      });
      expect(r.meta.partial).toEqual([0]);
      expect(r.tool_calls[0]!.function.arguments).toBe("{}");
    });

    it("no parameters schema on the tool -> rule inert, executable", () => {
      const r = normalizeMessage(nativeMessage({ path: "a.ts" }), {
        tools: [{ name: "write_file" }],
      });
      expect(r.meta.partial).toEqual([]);
    });

    it("no tools catalog at all -> rule inert, executable", () => {
      const r = normalizeMessage(nativeMessage({ path: "a.ts" }));
      expect(r.meta.partial).toEqual([]);
    });

    it("repair-fixes-it-first: type-coerced required value still counts present -> executable", () => {
      // content arrives as an object; schema wants a string. restringifyStringFields
      // (repair ladder) fixes the type BEFORE this gate judges presence — the
      // key was never missing, so the call must not be flagged partial.
      const r = normalizeMessage(nativeMessage({ path: "a.ts", content: { embedded: "json" } }), {
        tools: [writeFile],
      });
      expect(r.meta.partial).toEqual([]);
      const args = JSON.parse(r.tool_calls[0]!.function.arguments);
      expect(args.path).toBe("a.ts");
      expect(typeof args.content).toBe("string");
      expect(JSON.parse(args.content)).toEqual({ embedded: "json" });
    });
  });

  describe("real defect scenario (longcat extract, not fixed here — S1 is the safety net)", () => {
    // Known architectural defect (out of scope): longcat's extract() ARG_VAL
    // regex is structure-blind. Here "path"'s <longcat_arg_value> is never
    // closed, so the lazy regex swallows the rest of the block — including
    // the whole "content" key/value pair — into path's own value. The outer
    // block still closes cleanly, so extract().truncated stays [] and,
    // pre-S1, this call would come back complete (path only, no content)
    // and executable. This is the exact "write_file with path but no
    // content" damage described in the task.
    const malformed = dedent`
      <longcat_tool_call>
      write_file
      <longcat_arg_key>path</longcat_arg_key>
      <longcat_arg_value>a.ts
      <longcat_arg_key>content</longcat_arg_key>
      <longcat_arg_value>real content</longcat_arg_value>
      </longcat_tool_call>
    `;

    it("batch: content key is genuinely absent from extraction, but S1 marks the call partial", () => {
      const r = normalizeMessage(malformed, {
        dialect: "longcat",
        tools: [writeFile],
      });
      expect(r.tool_calls.map((t) => t.function.name)).toEqual(["write_file"]);
      expect(r.meta.partial).toEqual([0]);
      expect(r.tool_calls[0]!.function.arguments).toBe("{}");
    });

    it("stream: tool_call_end carries partial:true so downstream drops it", async () => {
      const events = await runStream([malformed], {
        dialect: "longcat",
        tools: [writeFile],
      });
      expectSequence(events, [end("write_file", undefined, { partial: true })]);
    });
  });
});
