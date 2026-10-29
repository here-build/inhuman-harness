import { describe, expect, it } from "vitest";

import { maybeUnstringifyJson, schemaRepairArgs, schemaRepairArgsJson } from "../schema-repair.js";
import type { ToolDef } from "../types.js";

const mcpCreate: ToolDef = {
  name: "create_remote_json_file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      body: { type: "string" },
    },
    required: ["path", "body"],
  },
};

const listPaths: ToolDef = {
  name: "list_paths",
  parameters: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" } },
    },
    required: ["paths"],
  },
};

const writeFile: ToolDef = {
  name: "write_file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
};

describe("schema-repair", () => {
  it("MCP JSON body string is NOT unstringified (must-not-ship #10)", () => {
    const args = {
      path: "users.json",
      body: '["a","b"]',
    };
    const out = schemaRepairArgs("create_remote_json_file", args, [mcpCreate]);
    expect(out.body).toBe('["a","b"]');
    expect(typeof out.body).toBe("string");
  });

  it("stringified array unstringifies when schema expects array", () => {
    const out = schemaRepairArgs("list_paths", { paths: '["a","b"]' }, [listPaths]);
    expect(out.paths).toEqual(["a", "b"]);
  });

  it("unstringify before wrap — not ['[\"a\"]']", () => {
    const out = schemaRepairArgs("list_paths", { paths: '["a"]' }, [listPaths]);
    expect(out.paths).toEqual(["a"]);
  });

  it("wrap bare non-JSON string as single-element string array", () => {
    const out = schemaRepairArgs("list_paths", { paths: "only-one" }, [listPaths]);
    expect(out.paths).toEqual(["only-one"]);
  });

  it("re-stringify when schema says string but value is object", () => {
    const out = schemaRepairArgs("write_file", { path: "a.json", content: { x: 1 } }, [writeFile]);
    expect(out.content).toBe('{"x":1}');
    expect(typeof out.content).toBe("string");
  });

  it("drop null on optional property", () => {
    const tool: ToolDef = {
      name: "t",
      parameters: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" },
        },
        required: ["a"],
      },
    };
    const out = schemaRepairArgs("t", { a: "x", b: null }, [tool]);
    expect(out).toEqual({ a: "x" });
  });

  it("no schema → no unstringify", () => {
    const out = schemaRepairArgs("unknown", { zip: "01234", body: '["a"]' }, []);
    expect(out).toEqual({ zip: "01234", body: '["a"]' });
  });

  it("maybeUnstringify keeps original on parse fail", () => {
    expect(
      maybeUnstringifyJson("[not json", {
        type: "array",
        items: { type: "string" },
      }),
    ).toBe("[not json");
  });

  it("schemaRepairArgsJson round-trip", () => {
    const json = schemaRepairArgsJson("list_paths", '{"paths":"[\\"a\\"]"}', [listPaths]);
    expect(JSON.parse(json)).toEqual({ paths: ["a"] });
  });
});
