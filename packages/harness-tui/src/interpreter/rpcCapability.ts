/**
 * Host-effect RPC for the command sandbox. The caller is configuration;
 * named symbols are the methods. Not PEW; not an InhumanAction.
 */
import { EnvCapability } from "@here.build/arrival";
import { z } from "zod";

export type RpcCall = (method: string, params?: unknown) => unknown | Promise<unknown>;

const scope = z.enum(["session", "project", "kernel"]);

export const rpcCapability = EnvCapability.define("harness/rpc", {
  configuration: {
    rpc: z.custom<RpcCall>((value) => typeof value === "function").optional(),
  },
  symbols: (symbol, sz) => {
    const params = sz.dictRecord(sz.foldName, sz.union([sz.foldName, sz.string, sz.box])).default({});
    const kvScope = sz.foldName.pipe(scope).optional();
    function call(this: { configuration: { rpc?: RpcCall } }, method: string, body?: unknown) {
      // `requiresConfig: ["rpc"]` doors every verb when the key is absent — present here.
      return this.configuration.rpc!(method, body);
    }
    return {
      rpc: symbol.rosetta`rpc: call a named host method`(
        {
          input: [sz.foldName, params],
          // The one legitimate z.dynamic: the verb is ∀-polymorphic in the host
          // method's result and passes it through whole.
          output: [sz.dynamic],
          provenance: "source",
          requiresConfig: ["rpc"],
        },
        async function (method, body) {
          return call.call(this, method, body);
        },
      ),
      "kv/set": symbol.rosetta`kv/set: write a string key`(
        {
          input: [sz.foldName, sz.string, kvScope],
          output: [sz.undefinedResult],
          provenance: "sink",
          effects: (key: string, _value: string, kv?: string) => [["kv", kv ?? "session", key]],
          requiresConfig: ["rpc"],
        },
        async function (key, value, kv) {
          const payload: Record<string, unknown> = { key, value };
          if (kv !== undefined) payload.scope = kv;
          await call.call(this, "kv/set", payload);
          return undefined;
        },
      ),
      "kv/clear": symbol.rosetta`kv/clear: clear a string key`(
        {
          input: [sz.foldName, kvScope],
          output: [sz.undefinedResult],
          provenance: "sink",
          effects: (key: string, kv?: string) => [["kv", kv ?? "session", key]],
          requiresConfig: ["rpc"],
        },
        async function (key, kv) {
          const payload: Record<string, unknown> = { key };
          if (kv !== undefined) payload.scope = kv;
          await call.call(this, "kv/clear", payload);
          return undefined;
        },
      ),
      "connect/adopt": symbol.rosetta`connect/adopt: adopt a connection; returns the host adoption result`(
        {
          input: [],
          inputRest: {
            driver: sz.foldName,
            name: sz.string.optional(),
            settings: sz.box.optional(),
          },
          // Source with consequences, not a sink: the host result (adopted id /
          // follow-up UI form) is real data the caller reads.
          output: [sz.box],
          provenance: "source",
          effects: (kwargs: { driver: string }) => [["connections", kwargs.driver]],
          queries: (kwargs: { driver: string }) => [["connections", kwargs.driver]],
          requiresConfig: ["rpc"],
        },
        async function (kwargs) {
          const payload: Record<string, unknown> = { driver: kwargs.driver };
          if (kwargs.name !== undefined) payload.name = kwargs.name;
          if (kwargs.settings !== undefined) payload.settings = kwargs.settings;
          return (await call.call(this, "connect/adopt", payload)) as object;
        },
      ),
      "connect/drop": symbol.rosetta`connect/drop: remove a connection`(
        {
          input: [sz.foldName],
          output: [sz.undefinedResult],
          provenance: "sink",
          effects: (id: string) => [["connections", id]],
          requiresConfig: ["rpc"],
        },
        async function (id) {
          await call.call(this, "connect/drop", { id });
          return undefined;
        },
      ),
    };
  },
});
