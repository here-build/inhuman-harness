import { OpenAPIGenerator, type JSONSchema } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import { contract, httpPathOf, listProcedures, type ContractEntry } from "../contract.js";
import { renderReadme } from "./readme.js";

type Json = Record<string, unknown>;
type JsonSchemaObject = Exclude<JSONSchema, boolean>;

const converter = new ZodToJsonSchemaConverter();

const INFO = (version: string) => ({
  title: "inhuman-harness daemon RPC",
  version,
});

/**
 * The OpenAPI view of the contract. This is the HTTP projection (one POST per
 * method, params as the JSON body); the daemon itself speaks JSON-RPC over a
 * WebSocket, see `openrpc.json` for the wire-accurate description.
 */
export async function generateOpenApi(version: string): Promise<Json> {
  const generator = new OpenAPIGenerator({ schemaConverters: [converter] });
  const document = (await generator.generate(contract, {
    info: {
      ...INFO(version),
      description:
        "HTTP projection of the daemon contract, generated from @inhuman.tools/harness-contract. " +
        "The daemon's only transport today is JSON-RPC 2.0 over WebSocket (see openrpc.json); each operation here " +
        "names its wire method in `x-rpc-method`.",
    },
  })) as unknown as Json;
  const byPath = new Map<string, ContractEntry>(listProcedures().map((entry) => [httpPathOf(entry.meta), entry]));
  const paths = (document.paths ?? {}) as Record<string, Record<string, Json>>;
  for (const [path, item] of Object.entries(paths)) {
    const entry = byPath.get(path);
    const operation = item.post;
    if (entry === undefined || operation === undefined) continue;
    operation["x-rpc-method"] = entry.meta.method;
    operation["x-host"] = entry.meta.host;
    if (entry.meta.mayPark === true) operation["x-may-park"] = true;
  }
  return document;
}

function schemaOf(schema: ContractEntry["procedure"]["~orpc"]["inputSchema"], strategy: "input" | "output") {
  const [, json] = converter.convert(schema, { strategy });
  return json;
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
  return schema.type === "object" && schema.anyOf === undefined && schema.oneOf === undefined;
}

/**
 * OpenRPC 1.3 description of the wire. Method names come from `meta.method`.
 * Params are by-name: an object input contributes one param per property; an
 * input that is not a plain object (a union) is given whole in `x-params-schema`.
 */
export async function generateOpenRpc(version: string): Promise<Json> {
  const methods: Json[] = [];
  for (const entry of listProcedures()) {
    const def = entry.procedure["~orpc"];
    const input = schemaOf(def.inputSchema, "input");
    const output = schemaOf(def.outputSchema, "output");
    const tags = def.route.tags?.map((name) => ({ name })) ?? [];
    const row: Json = {
      name: entry.meta.method,
      summary: def.route.summary,
      ...(def.route.description === undefined ? {} : { description: def.route.description }),
      tags,
      paramStructure: "by-name",
      params: [],
      result: { name: "result", schema: output },
      "x-host": entry.meta.host,
      ...(entry.meta.mayPark === true ? { "x-may-park": true } : {}),
    };
    if (typeof input !== "boolean" && isObjectSchema(input)) {
      const required = new Set(input.required);
      row.params = Object.entries(input.properties ?? {}).map(([name, schema]) => ({
        name,
        required: required.has(name),
        schema,
      }));
    } else {
      row["x-params-schema"] = input;
    }
    methods.push(row);
  }
  return {
    openrpc: "1.3.2",
    info: {
      ...INFO(version),
      description:
        "JSON-RPC 2.0 over WebSocket text frames on `<root>/daemon.sock`. Generated from @inhuman.tools/harness-contract.",
    },
    methods,
  };
}

export interface Artifact {
  readonly file: string;
  readonly text: string;
}

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Every generated file, by name relative to the package's `spec/` folder. */
export async function generateArtifacts(version: string): Promise<Artifact[]> {
  return [
    { file: "openapi.json", text: text(await generateOpenApi(version)) },
    { file: "openrpc.json", text: text(await generateOpenRpc(version)) },
    { file: "README.md", text: renderReadme(listProcedures()) },
  ];
}
