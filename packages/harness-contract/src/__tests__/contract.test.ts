import { describe, expect, it } from "vitest";

import { contract, httpPathOf, listProcedures, methodForPath, uiResolveInput } from "../index.js";
import { generateOpenApi, generateOpenRpc } from "../spec/generate.js";

describe("contract", () => {
  const entries = listProcedures();

  it("every procedure declares its wire name, host, input and output", () => {
    for (const entry of entries) {
      const def = entry.procedure["~orpc"];
      expect(entry.meta.method, entry.path.join(".")).toMatch(/^[a-z]+(-[a-z]+)*(\/[a-z]+(-[a-z]+)*)?$/);
      expect(["session", "kernel", "any"]).toContain(entry.meta.host);
      expect(def.inputSchema, entry.meta.method).toBeDefined();
      expect(def.outputSchema, entry.meta.method).toBeDefined();
      expect(def.route.summary, entry.meta.method).toBeTruthy();
      expect(def.route.path).toBe(httpPathOf(entry.meta));
    }
  });

  it("wire names and HTTP paths are unique per host; dual-host methods exist once per host", () => {
    const keys = entries.map((entry) => `${entry.meta.host}:${entry.meta.method}`);
    expect(new Set(keys).size).toBe(keys.length);
    const paths = entries.map((entry) => httpPathOf(entry.meta));
    expect(new Set(paths).size).toBe(paths.length);
    for (const dual of ["connect/adopt"]) {
      expect(keys.filter((key) => key.endsWith(`:${dual}`)).sort()).toEqual([`kernel:${dual}`, `session:${dual}`]);
    }
  });

  it("the parking methods are marked", () => {
    expect(
      entries
        .filter((entry) => entry.meta.mayPark === true)
        .map((entry) => `${entry.meta.host}:${entry.meta.method}`)
        .sort(),
    ).toEqual([
      "kernel:connect/adopt",
      "kernel:connect/drop",
      "kernel:connect/login",
      "kernel:mcp-server/adopt",
      "session:connect/adopt",
    ]);
  });

  it("maps a tree path to its wire name", () => {
    expect(methodForPath(["session", "kv", "set"])).toBe("kv/set");
    expect(methodForPath(["session", "turn", "send"])).toBe("turn");
    expect(methodForPath(["kernel", "connect", "adopt"])).toBe("connect/adopt");
    expect(methodForPath(["ui", "resolve"])).toBe("ui/resolve");
    expect(methodForPath(["session", "nope"])).toBeUndefined();
    expect(methodForPath(["session", "kv"])).toBeUndefined();
    expect(methodForPath(["constructor"])).toBeUndefined();
    expect(contract.session.kv.set["~orpc"].meta).toEqual({ method: "kv/set", host: "session" });
  });

  it("ui/resolve takes the pending id beside a closed answer", () => {
    expect(uiResolveInput.safeParse({ pending: "p", kind: "text", input: "x" }).success).toBe(true);
    expect(uiResolveInput.safeParse({ pending: "p", kind: "accept", extra: 1 }).success).toBe(false);
    expect(uiResolveInput.safeParse({ kind: "accept" }).success).toBe(false);
  });
});

describe("generated specs", () => {
  it("OpenRPC names methods by wire name and flags parks and hosts", async () => {
    const doc = (await generateOpenRpc("0.0.0")) as { openrpc: string; methods: Array<Record<string, unknown>> };
    expect(doc.openrpc).toBe("1.3.2");
    expect(doc.methods).toHaveLength(listProcedures().length);
    const drop = doc.methods.find((method) => method.name === "connect/drop");
    expect(drop).toMatchObject({ "x-host": "kernel", "x-may-park": true, paramStructure: "by-name" });
    const set = doc.methods.find((method) => method.name === "kv/set");
    expect(set).toMatchObject({
      params: [
        { name: "key", required: true },
        { name: "value", required: true },
        { name: "scope", required: false },
        { name: "remember", required: false },
      ],
    });
    expect(set?.["x-may-park"]).toBeUndefined();
  });

  it("OpenAPI has one POST operation per procedure, tagged with its wire method", async () => {
    const doc = (await generateOpenApi("0.0.0")) as { paths: Record<string, { post: Record<string, unknown> }> };
    expect(Object.keys(doc.paths)).toHaveLength(listProcedures().length);
    expect(doc.paths["/kernel/connect/adopt"]?.post).toMatchObject({
      "x-rpc-method": "connect/adopt",
      "x-host": "kernel",
      "x-may-park": true,
    });
  });
});
