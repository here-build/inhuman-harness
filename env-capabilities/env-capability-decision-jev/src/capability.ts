/**
 * `decide/yesno` and `decide/choose` through a Jev client.
 * The client class lives on `resources.Client`. A thrown error falls back to
 * `complete`; an abort does not. A failure is never an allow.
 */
import { EnvCapability } from "@here.build/arrival";
import { APIUserAbortError, TypeSafeClient, choice as choiceQuestion, noul } from "@typesafe-ai/sdk";
import { z } from "zod";

export class DecideError extends Error {
  override readonly name = "DecideError";

  static invariant(condition: unknown, message: string): asserts condition {
    if (!condition) throw new DecideError(message);
  }
}

export type DecideRequest =
  | { kind: "yesno"; instructions: string }
  | { kind: "choose"; instructions: string; options: readonly { option: string; description?: string }[] };

export type DecideComplete = (request: DecideRequest) => Promise<unknown>;

const NOT_A_VOTE = "structured answer is not a vote";

const decideRequest: z.ZodType<DecideRequest, DecideRequest> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("yesno"), instructions: z.string() }),
  z.object({
    kind: z.literal("choose"),
    instructions: z.string(),
    options: z.array(z.object({ option: z.string(), description: z.string().optional() })).readonly(),
  }),
]);

type JevCtor = new (options?: { apiKey?: string }) => {
  systemOne(input: {
    state: string;
    questions: Record<string, unknown>;
  }): Promise<{ answers: Record<string, unknown> }>;
};

const configuration = {
  document: z.string().default(""),
  apiKey: z.string().optional(),
  complete: z.function({ input: [decideRequest], output: z.promise(z.unknown()) }).optional(),
  Client: z.custom<JevCtor>((value) => typeof value === "function").optional(),
};

type Self = {
  readonly configuration: {
    readonly document: string;
    readonly apiKey?: string;
    readonly complete?: DecideComplete;
    readonly Client?: JevCtor;
  };
  readonly resources: { readonly Client: JevCtor };
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

function ask(complete: DecideComplete | undefined, request: DecideRequest): Promise<unknown> {
  DecideError.invariant(complete !== undefined, "no structured complete");
  return complete(request);
}

function isAbort(error: unknown): boolean {
  return (error instanceof Error && error.name === "AbortError") || error instanceof APIUserAbortError;
}

function judgedDocument(document: string, instructions: string): string {
  return document === "" ? instructions : document;
}

function nonEmpty(description: string | undefined): string | undefined {
  return description === undefined || description === "" ? undefined : description;
}

function askKey(key: string | undefined): string {
  if (key === undefined || key === "") throw new DecideError("missing api key");
  return key;
}

function noulVote(answer: unknown): "yes" | "no" | null {
  if (!isRecord(answer) || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) return null;
  return answer.noul >= 0.5 ? "yes" : "no";
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

function clientOf(self: Self): TypeSafeClient {
  if (self.configuration.Client === undefined) askKey(self.configuration.apiKey);
  const key = self.configuration.apiKey;
  const client = new self.resources.Client(key === undefined || key === "" ? undefined : { apiKey: key });
  if (typeof client.systemOne !== "function") throw new DecideError("jev client has no systemOne");
  return client as TypeSafeClient;
}

async function jevVote(self: Self, request: DecideRequest): Promise<unknown> {
  const document = judgedDocument(self.configuration.document, request.instructions);
  const client = clientOf(self);
  if (request.kind === "yesno") {
    const { answers } = await client.systemOne({
      state: document,
      questions: { vote: noul(request.instructions) },
    });
    return { value: noulVote(answers.vote) };
  }
  const criteria: Record<string, string | null> = {};
  for (const option of request.options) criteria[option.option] = nonEmpty(option.description) ?? null;
  const { answers } = await client.systemOne({
    state: document,
    questions: { vote: choiceQuestion(request.instructions, criteria) },
  });
  const chosen = answers.vote;
  return { value: isRecord(chosen) && typeof chosen.choice === "string" ? chosen.choice : null };
}

async function vote(self: Self, request: DecideRequest): Promise<unknown> {
  try {
    return { value: jsonValue(await jevVote(self, request)) };
  } catch (error) {
    if (isAbort(error)) throw error;
    return ask(self.configuration.complete, request);
  }
}

export const jevDecideCapability = EnvCapability.define("decision/jev", {
  configuration,
  resources: (config) => ({ Client: config.Client ?? (TypeSafeClient as unknown as JevCtor) }),
  symbols: (symbol, sz) => {
    const named = sz.union([sz.list([sz.foldName]), sz.list([sz.foldName, sz.string])]);
    const textOrFalse = sz.union([sz.string, sz.booleanFalse]);
    const yesOrNo = sz.union([sz.literal("yes"), sz.literal("no"), sz.booleanFalse]);
    return {
      "decide/yesno": symbol.rosetta`decide/yesno: yes, no, or #f`(
        { input: [sz.string], output: [yesOrNo], provenance: "source" },
        async function (instructions) {
          return yesNo(jsonValue(await vote(this as Self, { kind: "yesno", instructions })));
        },
      ),
      "decide/choose": symbol.rosetta`decide/choose: one of the options, or #f`(
        { input: [sz.string, sz.list(named)], output: [textOrFalse], provenance: "source" },
        async function (instructions, rows: readonly unknown[]) {
          const options = pairRows(rows).map(([option, description]) => {
            const text = nonEmpty(description);
            return text === undefined ? { option } : { option, description: text };
          });
          return choice(jsonValue(await vote(this as Self, { kind: "choose", instructions, options })), options);
        },
      ),
    };
  },
});
