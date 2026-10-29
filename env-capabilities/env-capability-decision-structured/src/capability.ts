/**
 * `decide/yesno` and `decide/choose`. `complete` returns JSON `{ value }`.
 * Scheme `#f` is an abstain. A missing complete is an error, never an allow.
 */
import { EnvCapability } from "@here.build/arrival";
import { z } from "zod";

export class DecideError extends Error {
  override readonly name = "DecideError";

  static invariant(condition: unknown, message: string): asserts condition {
    if (!condition) throw new DecideError(message);
  }
}

/** `document` is what is being decided on (the command or the path); absent when the host set none. */
export type DecideRequest =
  | { kind: "yesno"; instructions: string; document?: string }
  | {
      kind: "choose";
      instructions: string;
      options: readonly { option: string; description?: string }[];
      document?: string;
    };

export type DecideComplete = (request: DecideRequest) => Promise<unknown>;

const NOT_A_VOTE = "structured answer is not a vote";

const decideRequest: z.ZodType<DecideRequest, DecideRequest> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("yesno"), instructions: z.string(), document: z.string().optional() }),
  z.object({
    kind: z.literal("choose"),
    instructions: z.string(),
    document: z.string().optional(),
    options: z.array(z.object({ option: z.string(), description: z.string().optional() })).readonly(),
  }),
]);

const configuration = {
  document: z.string().default(""),
  complete: z.function({ input: [decideRequest], output: z.promise(z.unknown()) }).optional(),
};

type Self = {
  readonly configuration: {
    readonly document: string;
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

function ask(self: Self, request: DecideRequest): Promise<unknown> {
  const { complete, document } = self.configuration;
  DecideError.invariant(complete !== undefined, "no structured complete");
  return complete(document === "" ? request : { ...request, document });
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

function pairRows(rows: readonly unknown[]): readonly (readonly [string, string?])[] {
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length === 0 || row.length > 2 || typeof row[0] !== "string") {
      throw new DecideError(NOT_A_VOTE);
    }
    if (row.length === 1) return [row[0]];
    if (typeof row[1] !== "string") throw new DecideError(NOT_A_VOTE);
    return [row[0], row[1]];
  });
}

export const structuredOutputDecideCapability = EnvCapability.define("decision/structured", {
  configuration,
  symbols: (symbol, sz) => {
    const named = sz.union([sz.list([sz.foldName]), sz.list([sz.foldName, sz.string])]);
    const textOrFalse = sz.union([sz.string, sz.booleanFalse]);
    const yesOrNo = sz.union([sz.literal("yes"), sz.literal("no"), sz.booleanFalse]);
    return {
      "decide/yesno": symbol.rosetta`decide/yesno: yes, no, or #f`(
        { input: [sz.string], output: [yesOrNo], provenance: "source" },
        async function (instructions) {
          return yesNo(jsonValue(await ask(this as Self, { kind: "yesno", instructions })));
        },
      ),
      "decide/choose": symbol.rosetta`decide/choose: one of the options, or #f`(
        { input: [sz.string, sz.list(named)], output: [textOrFalse], provenance: "source" },
        async function (instructions, rows: readonly unknown[]) {
          const options = pairRows(rows).map(([option, description]) => {
            const text = nonEmpty(description);
            return text === undefined ? { option } : { option, description: text };
          });
          return choice(jsonValue(await ask(this as Self, { kind: "choose", instructions, options })), options);
        },
      ),
    };
  },
});
