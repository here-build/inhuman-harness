/**
 * `decide/yesno` and `decide/choose`, plus Sage's scale, gauge, tag, and sort.
 * `SageSDK` decides from `apiKey`. A thrown error falls back to `complete`;
 * an abort does not. A failure is never an allow.
 */
import { EnvCapability } from "@here.build/arrival";
import { SageAnswer, SageError, SageSDK } from "sage-sdk";
import { z } from "zod";

export class DecideError extends Error {
  override readonly name = "DecideError";

  static invariant(condition: unknown, message: string): asserts condition {
    if (!condition) throw new DecideError(message);
  }
}

export type DecideRequest =
  | { kind: "yesno"; instructions: string }
  | { kind: "choose"; instructions: string; options: readonly { option: string; description?: string }[] }
  | { kind: "scale"; instructions: string; levels: readonly { level: number; description?: string }[] }
  | { kind: "gauge"; instructions: string; start: number; end: number; step: number }
  | { kind: "tag"; instructions: string; tags: readonly { tag: string; description?: string }[] }
  | { kind: "sort"; instructions: string; items: readonly { id: string; content: string }[] };

export type DecideComplete = (request: DecideRequest) => Promise<unknown>;

const NOT_A_VOTE = "structured answer is not a vote";
const ABORTED = "Request was aborted.";

const decideRequest: z.ZodType<DecideRequest, DecideRequest> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("yesno"), instructions: z.string() }),
  z.object({
    kind: z.literal("choose"),
    instructions: z.string(),
    options: z.array(z.object({ option: z.string(), description: z.string().optional() })).readonly(),
  }),
  z.object({
    kind: z.literal("scale"),
    instructions: z.string(),
    levels: z.array(z.object({ level: z.number(), description: z.string().optional() })).readonly(),
  }),
  z.object({
    kind: z.literal("gauge"),
    instructions: z.string(),
    start: z.number(),
    end: z.number(),
    step: z.number(),
  }),
  z.object({
    kind: z.literal("tag"),
    instructions: z.string(),
    tags: z.array(z.object({ tag: z.string(), description: z.string().optional() })).readonly(),
  }),
  z.object({
    kind: z.literal("sort"),
    instructions: z.string(),
    items: z.array(z.object({ id: z.string(), content: z.string() })).readonly(),
  }),
]);

const configuration = {
  document: z.string().default(""),
  apiKey: z.string().optional(),
  fetch: z.custom<typeof fetch>((value) => typeof value === "function").optional(),
  complete: z.function({ input: [decideRequest], output: z.promise(z.unknown()) }).optional(),
};

type Self = {
  readonly configuration: {
    readonly document: string;
    readonly apiKey?: string;
    readonly fetch?: typeof fetch;
    readonly complete?: DecideComplete;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(raw: unknown): unknown {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DecideError(NOT_A_VOTE);
    }
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, "value")) throw new DecideError(NOT_A_VOTE);
  return parsed.value;
}

function isAbort(error: unknown): boolean {
  if (error instanceof SageError) return error.kind === "timeout" && error.detail === ABORTED;
  return error instanceof Error && error.name === "AbortError";
}

function nonEmpty(description: string | undefined): string | undefined {
  return description === undefined || description === "" ? undefined : description;
}

function yesNo(value: unknown): "yes" | "no" | false {
  if (value === null) return false;
  if (value === "yes" || value === "no") return value;
  throw new DecideError(NOT_A_VOTE);
}

function choice(value: unknown, options: readonly { option: string }[]): string | false {
  if (value === null) return false;
  if (typeof value !== "string") throw new DecideError(NOT_A_VOTE);
  DecideError.invariant(
    options.some((row) => row.option === value),
    "choice outside options",
  );
  return value;
}

function expectation(value: unknown): number {
  DecideError.invariant(typeof value === "number" && Number.isFinite(value), NOT_A_VOTE);
  return value;
}

function pairRows(rows: readonly unknown[], head: "string"): readonly (readonly [string, string?])[];
function pairRows(rows: readonly unknown[], head: "number"): readonly (readonly [number, string?])[];
function pairRows(
  rows: readonly unknown[],
  head: "string" | "number",
): readonly (readonly [string | number, string?])[] {
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length === 0 || row.length > 2) throw new DecideError(NOT_A_VOTE);
    const name = row[0];
    if (head === "string" ? typeof name !== "string" : typeof name !== "number") throw new DecideError(NOT_A_VOTE);
    if (row.length === 1) return [name];
    if (typeof row[1] !== "string") throw new DecideError(NOT_A_VOTE);
    return [name, row[1]];
  });
}

function itemRows(rows: readonly unknown[]): readonly (readonly [string, string])[] {
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string") {
      throw new DecideError(NOT_A_VOTE);
    }
    return [row[0], row[1]];
  });
}

function tagVotes(value: unknown, tags: readonly { tag: string }[]): [string, boolean | null][] {
  if (!isRecord(value)) throw new DecideError(NOT_A_VOTE);
  const known = new Set(tags.map((row) => row.tag));
  for (const key of Object.keys(value)) DecideError.invariant(known.has(key), `tag on a missing id ${key}`);
  return tags.map((row) => {
    DecideError.invariant(Object.hasOwn(value, row.tag), NOT_A_VOTE);
    const applies = value[row.tag];
    if (applies === null || typeof applies === "boolean") return [row.tag, applies];
    throw new DecideError(NOT_A_VOTE);
  });
}

function permutation(value: unknown, items: readonly { id: string }[]): string[] {
  if (!Array.isArray(value)) throw new DecideError(NOT_A_VOTE);
  const ids = value.map((id) => {
    if (typeof id !== "string") throw new DecideError(NOT_A_VOTE);
    return id;
  });
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  DecideError.invariant(ids.length === items.length, "sort is not a permutation");
  for (const id of ids) {
    const left = counts.get(id) ?? 0;
    DecideError.invariant(left > 0, "sort is not a permutation");
    counts.set(id, left - 1);
  }
  return ids;
}

function gaugeStep(start: number, end: number, step: number | undefined): number {
  DecideError.invariant(Number.isInteger(start), "range start must be an integer");
  DecideError.invariant(Number.isInteger(end), "range end must be an integer");
  const resolved = step ?? (end < start ? -1 : 1);
  DecideError.invariant(Number.isInteger(resolved) && resolved !== 0, "range step must be a non-zero integer");
  DecideError.invariant(start !== end, "gauge must produce 2..26 levels");
  DecideError.invariant((end - start) * resolved > 0, "range step must move from start toward end");
  const count = (end - start) / resolved + 1;
  DecideError.invariant(Number.isInteger(count), "range end must fall on a step");
  DecideError.invariant(count >= 2 && count <= 26, "gauge must produce 2..26 levels");
  return resolved;
}

function optionRow(option: string, description: string | undefined): { option: string; description?: string } {
  const text = nonEmpty(description);
  return text === undefined ? { option } : { option, description: text };
}

function levelRow(level: number, description: string | undefined): { level: number; description?: string } {
  const text = nonEmpty(description);
  return text === undefined ? { level } : { level, description: text };
}

function tagRow(tag: string, description: string | undefined): { tag: string; description?: string } {
  const text = nonEmpty(description);
  return text === undefined ? { tag } : { tag, description: text };
}

function sageOf(self: Self, document: string): SageAnswer {
  const key = self.configuration.apiKey;
  if (key === undefined || key === "") throw new DecideError("missing api key");
  const transport = self.configuration.fetch;
  const sdk = new SageSDK(transport === undefined ? { apiKey: key } : { apiKey: key, fetch: transport });
  return sdk.sageAnswer(document);
}

async function sageVote(self: Self, request: DecideRequest): Promise<unknown> {
  const document = self.configuration.document === "" ? request.instructions : self.configuration.document;
  const sage = sageOf(self, document);
  switch (request.kind) {
    case "yesno":
      return sage.yesOrNo(request.instructions);
    case "choose":
      return sage.choose(
        request.instructions,
        request.options.map((row) => optionRow(row.option, row.description)),
      );
    case "scale":
      return sage.scale(
        request.instructions,
        request.levels.map((row) => levelRow(row.level, row.description)),
      );
    case "gauge":
      return sage.gauge(request.instructions, request.start, request.end, request.step);
    case "tag":
      return sage.tag(
        request.instructions,
        request.tags.map((row) => tagRow(row.tag, row.description)),
      );
    case "sort": {
      const ranked = await sage.sort(request.instructions, request.items);
      return ranked.map((item) => item.id);
    }
    default: {
      const unreachable: never = request;
      return unreachable;
    }
  }
}

async function vote(self: Self, request: DecideRequest): Promise<unknown> {
  try {
    return await sageVote(self, request);
  } catch (error) {
    if (isAbort(error)) throw error;
    const complete = self.configuration.complete;
    DecideError.invariant(complete !== undefined, "no structured complete");
    return jsonValue(await complete(request));
  }
}

export const sageDecideCapability = EnvCapability.define("decision/sage", {
  configuration,
  symbols: (symbol, sz) => {
    const named = sz.union([sz.list([sz.foldName]), sz.list([sz.foldName, sz.string])]);
    const levels = sz.union([sz.list([sz.integer]), sz.list([sz.integer, sz.string])]);
    const textOrFalse = sz.union([sz.string, sz.booleanFalse]);
    const yesOrNo = sz.union([sz.literal("yes"), sz.literal("no"), sz.booleanFalse]);
    const applies = sz.union([sz.boolean, sz.nil]);
    return {
      "decide/yesno": symbol.rosetta`decide/yesno: yes, no, or #f`(
        { input: [sz.string], output: [yesOrNo], provenance: "source" },
        async function (instructions) {
          return yesNo(await vote(this as Self, { kind: "yesno", instructions }));
        },
      ),
      "decide/choose": symbol.rosetta`decide/choose: one of the options, or #f`(
        { input: [sz.string, sz.list(named)], output: [textOrFalse], provenance: "source" },
        async function (instructions, rows: readonly unknown[]) {
          const options = pairRows(rows, "string").map(([option, description]) => optionRow(option, description));
          return choice(await vote(this as Self, { kind: "choose", instructions, options }), options);
        },
      ),
      "decide/scale": symbol.rosetta`decide/scale: expectation on named levels`(
        { input: [sz.string, sz.list(levels)], output: [sz.number], provenance: "source" },
        async function (instructions, rows: readonly unknown[]) {
          const scaleLevels = pairRows(rows, "number").map(([level, description]) => levelRow(level, description));
          return expectation(await vote(this as Self, { kind: "scale", instructions, levels: scaleLevels }));
        },
      ),
      "decide/gauge": symbol.rosetta`decide/gauge: expectation on an integer range of 2..26 levels`(
        {
          input: [sz.string, sz.integer, sz.integer, sz.integer.optional()],
          output: [sz.number],
          provenance: "source",
        },
        async function (instructions, start, end, step) {
          return expectation(
            await vote(this as Self, { kind: "gauge", instructions, start, end, step: gaugeStep(start, end, step) }),
          );
        },
      ),
      "decide/tag": symbol.rosetta`decide/tag: alist of tag and whether it applies`(
        { input: [sz.string, sz.list(named)], output: [sz.list(sz.cons(sz.string, applies))], provenance: "source" },
        async function (instructions, rows: readonly unknown[]) {
          const tags = pairRows(rows, "string").map(([tag, description]) => tagRow(tag, description));
          return tagVotes(await vote(this as Self, { kind: "tag", instructions, tags }), tags);
        },
      ),
      "decide/sort": symbol.rosetta`decide/sort: permutation of the item ids`(
        {
          input: [sz.string, sz.list(sz.list([sz.foldName, sz.string]))],
          output: [sz.list(sz.string)],
          provenance: "source",
        },
        async function (instructions, rows: readonly unknown[]) {
          const items = itemRows(rows).map(([id, content]) => ({ id, content }));
          return permutation(await vote(this as Self, { kind: "sort", instructions, items }), items);
        },
      ),
    };
  },
});
