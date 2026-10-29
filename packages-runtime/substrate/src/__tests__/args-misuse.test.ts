// One table per incident: clue extraction, localization, escalation counters,
// retry-shape composition, and the missing-required teaching line.

import { parse } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { ArgsFailureTracker, type ArgsFailureState } from "../args-failure-tracker.js";
import { buildRetryShape, renderArgsMisuseTeaching } from "../args-misuse-door.js";
import { extractClues, localizeFailingParam, type ArgsClue, type Localized } from "../args-misuse.js";
import type { JsonSchemaProperty, ToolJsonSchema } from "../tool-schema.js";

const QUERY_OBJECT: JsonSchemaProperty = {
  type: "object",
  properties: {
    cond: { type: "string", description: "Conditions or disease query." },
    term: { type: "string", description: "Other terms query." },
  },
};

const QUERY_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    query: QUERY_OBJECT,
    filter: {
      type: "object",
      properties: { advanced: { type: "string" } },
      additionalProperties: false,
    },
  },
};

const ADD_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: { a: { type: "number" }, b: { type: "number" } },
  required: ["a", "b"],
};

const KING_SAUD =
  '{"detail":"Failed to call tool \'clinicaltrialsgov-mcp-server_clinicaltrials_list_studies\': ' +
  "Input validation error: 'King Saud University' is not of type 'object'\"}";

const TERMS_UNEXPECTED =
  '{"detail":"Failed to call tool \'clinicaltrialsgov-mcp-server_clinicaltrials_list_studies\': ' +
  "Input validation error: Additional properties are not allowed ('terms' was unexpected)\"}";

interface ClueRow {
  name: string;
  text: string;
  clues: readonly ArgsClue[];
}

const CLUE_ROWS: readonly ClueRow[] = [
  {
    name: "value-mismatch",
    text: KING_SAUD,
    clues: [{ kind: "value-mismatch", tokens: ["King Saud University"], expectedType: "object" }],
  },
  {
    name: "unexpected key",
    text: TERMS_UNEXPECTED,
    clues: [{ kind: "unexpected-keys", tokens: ["terms"] }],
  },
  {
    name: "several unexpected keys",
    text: "Additional properties are not allowed ('k1', 'k2' were unexpected)",
    clues: [{ kind: "unexpected-keys", tokens: ["k1", "k2"] }],
  },
  {
    name: "required key",
    text: "'cond' is a required property",
    clues: [{ kind: "required-key", tokens: ["cond"] }],
  },
  {
    name: "zod path",
    text:
      "Input validation error: Invalid arguments for tool clinicaltrials/list_studies: " +
      '[{"code": "invalid_type", "expected": "object", "received": "string", "path": ["query"], ' +
      '"message": "Expected object, received string"}]',
    clues: [{ kind: "zod-path", tokens: ["query"] }],
  },
  {
    name: "nested zod path",
    text: '[{"code": "invalid_type", "path": ["filter", "startDate"], "message": "…"}]',
    clues: [{ kind: "zod-path", tokens: ["filter", "startDate"] }],
  },
  {
    name: "one zod clue per issue",
    text: '[{"path": ["a"], "message": "one"}, {"path": ["b", "c"], "message": "two"}]',
    clues: [
      { kind: "zod-path", tokens: ["a"] },
      { kind: "zod-path", tokens: ["b", "c"] },
    ],
  },
  {
    name: "no recognized family",
    text: "ValueError: database connection refused",
    clues: [],
  },
  {
    name: "family priority",
    text:
      '[{"path": ["query"], "message": "m"}] ' +
      "'King Saud University' is not of type 'object' " +
      "Additional properties are not allowed ('terms' was unexpected) " +
      "'cond' is a required property",
    clues: [
      { kind: "zod-path", tokens: ["query"] },
      { kind: "value-mismatch", tokens: ["King Saud University"], expectedType: "object" },
      { kind: "unexpected-keys", tokens: ["terms"] },
      { kind: "required-key", tokens: ["cond"] },
    ],
  },
  {
    name: "own-decode unknown key outranks the missing key",
    text: "toy/add: arguments rejected — 2 problem(s):\n  :aa — unknown key\n  :a — missing (required)",
    clues: [
      { kind: "own-unknown-key", tokens: ["aa"] },
      { kind: "own-decode", tokens: ["a"], issue: "missing (required)" },
    ],
  },
  {
    name: "a stray keyword line is not an own-decode clue",
    text: "  :foo — something upstream said",
    clues: [],
  },
];

interface LocalRow {
  name: string;
  text: string;
  sentArgs: Record<string, unknown> | undefined;
  schema: ToolJsonSchema | undefined;
  localized: Localized | undefined;
}

const FILTER_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: { filter: { type: "object", properties: { advanced: { type: "string" } } } },
};

const TWO_STRINGS: ToolJsonSchema = {
  type: "object",
  properties: { a: { type: "string" }, b: { type: "string" } },
};

const COND_TOP: ToolJsonSchema = {
  type: "object",
  properties: { cond: { type: "string" } },
  required: ["cond"],
};

const QUERY_AND_FILTER: ToolJsonSchema = {
  type: "object",
  properties: { query: { type: "object" }, filter: { type: "object" } },
};

const TWO_COND_CONTAINERS: ToolJsonSchema = {
  type: "object",
  properties: {
    query: { type: "object", properties: { cond: { type: "string" } }, required: ["cond"] },
    filter: { type: "object", properties: { cond: { type: "string" } }, required: ["cond"] },
  },
};

const NESTED_QUERY: JsonSchemaProperty = {
  type: "object",
  properties: { cond: { type: "string" }, term: { type: "string" } },
  required: ["cond"],
};

const NESTED_COND: ToolJsonSchema = {
  type: "object",
  properties: { query: NESTED_QUERY },
};

const LOCAL_ROWS: readonly LocalRow[] = [
  {
    name: "value-mismatch under the sent scalar",
    text: "{\"detail\":\"Failed to call tool 'x': Input validation error: 'King Saud University' is not of type 'object'\"}",
    sentArgs: { query: "King Saud University" },
    schema: QUERY_SCHEMA,
    localized: {
      path: ["query"],
      clue: { kind: "value-mismatch", tokens: ["King Saud University"], expectedType: "object" },
      subSchema: QUERY_OBJECT,
      sentValue: "King Saud University",
    },
  },
  {
    name: "unexpected key localizes to the containing object",
    text: "Additional properties are not allowed ('terms' was unexpected)",
    sentArgs: { query: { terms: "King Saud University" } },
    schema: QUERY_SCHEMA,
    localized: {
      path: ["query"],
      clue: { kind: "unexpected-keys", tokens: ["terms"] },
      subSchema: QUERY_OBJECT,
      sentValue: { terms: "King Saud University" },
    },
  },
  {
    name: "zod path resolves without a walk",
    text: '[{"path": ["filter", "advanced"], "message": "Expected string, received number"}]',
    sentArgs: { filter: { advanced: 5 } },
    schema: FILTER_SCHEMA,
    localized: {
      path: ["filter", "advanced"],
      clue: { kind: "zod-path", tokens: ["filter", "advanced"] },
      subSchema: { type: "string" },
      sentValue: 5,
    },
  },
  {
    name: "zod path absent from the schema",
    text: '[{"path": ["nonexistent"], "message": "…"}]',
    sentArgs: { nonexistent: "x" },
    schema: QUERY_SCHEMA,
    localized: undefined,
  },
  {
    name: "value-mismatch token missing from sent args",
    text: "'King Saud University' is not of type 'object'",
    sentArgs: { query: "<computed>" },
    schema: QUERY_SCHEMA,
    localized: undefined,
  },
  {
    name: "the same value on two params",
    text: "'duplicate' is not of type 'number'",
    sentArgs: { a: "duplicate", b: "duplicate" },
    schema: TWO_STRINGS,
    localized: undefined,
  },
  {
    name: "value-mismatch without sent args",
    text: "'King Saud University' is not of type 'object'",
    sentArgs: undefined,
    schema: QUERY_SCHEMA,
    localized: undefined,
  },
  {
    name: "no schema",
    text: "'King Saud University' is not of type 'object'",
    sentArgs: { query: "King Saud University" },
    schema: undefined,
    localized: undefined,
  },
  {
    name: "required key at the top level",
    text: "'cond' is a required property",
    sentArgs: {},
    schema: COND_TOP,
    localized: {
      path: ["cond"],
      clue: { kind: "required-key", tokens: ["cond"] },
      subSchema: { type: "string" },
      sentValue: undefined,
    },
  },
  {
    name: "multi-issue zod uses the first sound path",
    text: '[{"path": ["query"], "message": "one"}, {"path": ["filter"], "message": "two"}]',
    sentArgs: { query: 1, filter: 2 },
    schema: QUERY_AND_FILTER,
    localized: {
      path: ["query"],
      clue: { kind: "zod-path", tokens: ["query"] },
      subSchema: { type: "object" },
      sentValue: 1,
    },
  },
  {
    name: "multi-issue zod skips an unsound first path",
    text: '[{"path": ["ghost"], "message": "one"}, {"path": ["filter"], "message": "two"}]',
    sentArgs: { filter: 2 },
    schema: QUERY_AND_FILTER,
    localized: {
      path: ["filter"],
      clue: { kind: "zod-path", tokens: ["filter"] },
      subSchema: { type: "object" },
      sentValue: 2,
    },
  },
  {
    name: "required key in two sent containers",
    text: "'cond' is a required property",
    sentArgs: { query: {}, filter: {} },
    schema: TWO_COND_CONTAINERS,
    localized: undefined,
  },
  {
    name: "required key nested in the sent object",
    text: "'cond' is a required property",
    sentArgs: { query: { term: "x" } },
    schema: NESTED_COND,
    localized: {
      path: ["query"],
      clue: { kind: "required-key", tokens: ["cond"] },
      subSchema: NESTED_QUERY,
      sentValue: { term: "x" },
    },
  },
  {
    name: "unknown key tight-matches one param",
    text: "toy/add: arguments rejected — 1 problem(s):\n  :aa — unknown key",
    sentArgs: undefined,
    schema: ADD_SCHEMA,
    localized: {
      path: ["a"],
      clue: { kind: "own-unknown-key", tokens: ["aa"] },
      subSchema: { type: "number" },
    },
  },
  {
    name: "unknown key outranks the missing key it caused",
    text: "toy/add: arguments rejected — 2 problem(s):\n  :aa — unknown key\n  :a — missing (required)",
    sentArgs: undefined,
    schema: ADD_SCHEMA,
    localized: {
      path: ["a"],
      clue: { kind: "own-unknown-key", tokens: ["aa"] },
      subSchema: { type: "number" },
    },
  },
  {
    name: "unknown key with no tight match",
    text: "t: arguments rejected — 1 problem(s):\n  :zz — unknown key",
    sentArgs: undefined,
    schema: ADD_SCHEMA,
    localized: undefined,
  },
  {
    name: "unknown key tight-matching two params",
    text: "t: arguments rejected — 1 problem(s):\n  :ab — unknown key",
    sentArgs: undefined,
    schema: ADD_SCHEMA,
    localized: undefined,
  },
];

type TrackerStep =
  | { op: "fail"; tool: string; param: readonly string[] | undefined }
  | { op: "success"; tool: string }
  | { op: "roundTrip" }
  | { op: "import"; state: ArgsFailureState };

function levelsOf(steps: readonly TrackerStep[]): number[] {
  let tracker = new ArgsFailureTracker();
  const levels: number[] = [];
  for (const step of steps) {
    switch (step.op) {
      case "fail":
        levels.push(tracker.recordFailure(step.tool, step.param));
        break;
      case "success":
        tracker.recordSuccess(step.tool);
        break;
      case "roundTrip": {
        const restored = new ArgsFailureTracker();
        restored.importState(tracker.exportState());
        tracker = restored;
        break;
      }
      case "import":
        tracker.importState(step.state);
        break;
    }
  }
  return levels;
}

function fail(tool: string, param: readonly string[] | undefined): TrackerStep {
  return { op: "fail", tool, param };
}

function corruptArgsState(): ArgsFailureState {
  const valid = new ArgsFailureTracker();
  valid.recordFailure("t/tool", ["ok"]);
  valid.recordFailure("t/tool", ["ok"]);
  const [okEntry] = valid.exportState().entries;
  const key = (suffix: string): string => okEntry[0].replace("ok", suffix);
  return {
    entries: [
      okEntry,
      [key("zero"), 0],
      [key("neg"), -5],
      [key("big"), 99],
      [key("frac"), 2.5],
      [key("nan"), Number.NaN],
    ],
  };
}

interface TrackerRow {
  name: string;
  steps: readonly TrackerStep[];
  levels: readonly number[];
}

const TRACKER_ROWS: readonly TrackerRow[] = [
  {
    name: "monotone 1→2→3, then capped",
    steps: [
      fail("t/tool", ["query"]),
      fail("t/tool", ["query"]),
      fail("t/tool", ["query"]),
      fail("t/tool", ["query"]),
      fail("t/tool", ["query"]),
    ],
    levels: [1, 2, 3, 3, 3],
  },
  {
    name: "a different param starts at 1",
    steps: [
      fail("t/tool", ["query"]),
      fail("t/tool", ["query"]),
      fail("t/tool", ["filter"]),
      fail("t/tool", ["query"]),
    ],
    levels: [1, 2, 1, 3],
  },
  {
    name: "the same param on another tool starts at 1",
    steps: [fail("t/tool-a", ["query"]), fail("t/tool-a", ["query"]), fail("t/tool-b", ["query"])],
    levels: [1, 2, 1],
  },
  {
    name: "success clears every param of that tool",
    steps: [
      fail("t/tool", ["query"]),
      fail("t/tool", ["query"]),
      fail("t/tool", ["filter"]),
      { op: "success", tool: "t/tool" },
      fail("t/tool", ["query"]),
      fail("t/tool", ["filter"]),
    ],
    levels: [1, 2, 1, 1, 1],
  },
  {
    name: "success does not clear another tool",
    steps: [
      fail("t/tool-a", ["query"]),
      fail("t/tool-a", ["query"]),
      { op: "success", tool: "t/tool-b" },
      fail("t/tool-a", ["query"]),
    ],
    levels: [1, 2, 3],
  },
  {
    name: "an unlocalized failure escalates and resets on success",
    steps: [
      fail("t/tool", undefined),
      fail("t/tool", undefined),
      fail("t/tool", undefined),
      fail("t/tool", undefined),
      { op: "success", tool: "t/tool" },
      fail("t/tool", undefined),
    ],
    levels: [1, 2, 3, 3, 1],
  },
  {
    name: "an unlocalized failure is separate from a named param",
    steps: [fail("t/tool", undefined), fail("t/tool", undefined), fail("t/tool", ["query"])],
    levels: [1, 2, 1],
  },
  {
    name: "export/import round-trips the counters",
    steps: [
      fail("t/tool", ["query"]),
      fail("t/tool", ["query"]),
      fail("t/tool", undefined),
      { op: "roundTrip" },
      fail("t/tool", ["query"]),
      fail("t/tool", undefined),
    ],
    levels: [1, 2, 1, 3, 2],
  },
  {
    name: "import replaces the counters",
    steps: [
      fail("t/tool", ["query"]),
      fail("t/tool", ["query"]),
      { op: "import", state: { entries: [] } },
      fail("t/tool", ["query"]),
    ],
    levels: [1, 2, 1],
  },
  {
    name: "import drops a counter that is not a level",
    steps: [
      { op: "import", state: corruptArgsState() },
      fail("t/tool", ["ok"]),
      fail("t/tool", ["zero"]),
      fail("t/tool", ["neg"]),
      fail("t/tool", ["big"]),
      fail("t/tool", ["frac"]),
      fail("t/tool", ["nan"]),
    ],
    levels: [3, 1, 1, 1, 1, 1],
  },
];

const QUALIFIED = "clinicaltrialsgov-mcp-server/clinicaltrials_list_studies";

const QUERY_MENU =
  ":cond is one example key; pick the key matching your intent: cond (Conditions or disease query.), term (Other terms query.)";

interface RetryRow {
  name: string;
  error: string;
  sentArgs: Record<string, unknown> | undefined;
  schema: ToolJsonSchema;
  path: readonly string[] | undefined;
  shape: { expr: string; menu?: string } | undefined;
  blindParses?: boolean;
  filledSource?: string;
}

const RETRY_ROWS: readonly RetryRow[] = [
  {
    name: "value-mismatch rewrites the param with a hole and a menu",
    error: "'King Saud University' is not of type 'object'",
    sentArgs: { query: "King Saud University", pageSize: 50 },
    schema: { type: "object", properties: { query: QUERY_OBJECT, pageSize: { type: "number" } } },
    path: ["query"],
    shape: {
      expr: `(${QUALIFIED} :query {:cond #|string|#} :pageSize 50)`,
      menu: QUERY_MENU,
    },
    blindParses: false,
    filledSource: '"diabetes"',
  },
  {
    name: "an edit-distance rename echoes the sent object",
    error: "Additional properties are not allowed ('terms' was unexpected)",
    sentArgs: { query: { terms: "King Saud University" } },
    schema: { type: "object", properties: { query: QUERY_OBJECT } },
    path: ["query"],
    shape: { expr: `(${QUALIFIED} :query {:term "King Saud University"})` },
    blindParses: true,
  },
  {
    name: "a nested failing path declines",
    error: '[{"path": ["filter", "geo"], "message": "m"}]',
    sentArgs: { filter: { geo: "x" } },
    schema: { type: "object", properties: { filter: { type: "object", properties: { geo: { type: "string" } } } } },
    path: ["filter", "geo"],
    shape: undefined,
  },
  {
    name: "no sent args declines",
    error: '[{"path": ["query"], "message": "m"}]',
    sentArgs: undefined,
    schema: { type: "object", properties: { query: QUERY_OBJECT } },
    path: ["query"],
    shape: undefined,
  },
  {
    name: "a rename that would clobber an existing key falls back to a hole",
    error: "Additional properties are not allowed ('terms' was unexpected)",
    sentArgs: { query: { terms: "bad spelling", term: "the real one" } },
    schema: { type: "object", properties: { query: QUERY_OBJECT } },
    path: ["query"],
    shape: {
      expr: `(${QUALIFIED} :query {:cond #|string|#})`,
      menu: QUERY_MENU,
    },
  },
];

async function parsesAsOneForm(expr: string): Promise<boolean> {
  try {
    const forms = await parse(expr);
    return forms.length === 1;
  } catch {
    return false;
  }
}

const DISCOVERY_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: { repo_path: { type: "string" }, revision: { type: "string" } },
  required: ["repo_path"],
};

interface TeachRow {
  name: string;
  error: string;
  body: string;
}

const TEACH_ROWS: readonly TeachRow[] = [
  {
    name: "a missing required arg says to discover it",
    error: "git/git_log: arguments rejected — 1 problem(s):\n  :repo_path — missing (required)",
    body:
      "\n  Failing argument: :repo_path — it is required and was not sent; it takes a value of type string. " +
      "If you don't have a value for it, discover it with a listing/search tool from the bound set " +
      "(enumerate the resource) rather than asking the user for it.",
  },
  {
    name: "a type mismatch does not say to discover it",
    error: "git/git_log: arguments rejected — 1 problem(s):\n  :repo_path — expected string, got number: 5",
    body: "\n  Failing argument: :repo_path — the tool's schema rejected it; :repo_path takes a value of type string.",
  },
];

describe("extractClues", () => {
  it.each(CLUE_ROWS)("$name", ({ text, clues }) => {
    expect(extractClues(text)).toEqual(clues);
  });
});

describe("localizeFailingParam", () => {
  it.each(LOCAL_ROWS)("$name", ({ text, sentArgs, schema, localized }) => {
    expect(localizeFailingParam(text, sentArgs, schema)).toEqual(localized);
  });

  it("a planted value collision amid noise stays undefined", () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return seed / 0x7f_ff_ff_ff;
    };
    const randomString = (): string => Math.floor(rand() * 1e9).toString(36);

    for (let i = 0; i < 50; i++) {
      const collisionValue = `collide-${i}`;
      const noiseKeys = Math.floor(rand() * 4);
      const sentArgs: Record<string, unknown> = { alpha: collisionValue, beta: collisionValue };
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { alpha: { type: "string" }, beta: { type: "string" } },
      };
      for (let n = 0; n < noiseKeys; n++) sentArgs[`noise${n}`] = randomString();
      const errorText = `'${collisionValue}' is not of type 'number'`;
      expect(localizeFailingParam(errorText, sentArgs, schema)).toBeUndefined();
    }
  });

  it("one planted match amid noise resolves to that path", () => {
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return seed / 0x7f_ff_ff_ff;
    };
    const randomString = (): string => Math.floor(rand() * 1e9).toString(36);

    for (let i = 0; i < 50; i++) {
      const target = `unique-${i}`;
      const noiseKeys = Math.floor(rand() * 4);
      const sentArgs: Record<string, unknown> = { needle: target };
      const schema: ToolJsonSchema = { type: "object", properties: { needle: { type: "string" } } };
      for (let n = 0; n < noiseKeys; n++) {
        const noiseVal = randomString();
        sentArgs[`noise${n}`] = noiseVal;
        (schema.properties as Record<string, JsonSchemaProperty>)[`noise${n}`] = { type: "string" };
      }
      const errorText = `'${target}' is not of type 'number'`;
      const localized = localizeFailingParam(errorText, sentArgs, schema);
      expect(localized?.path).toEqual(["needle"]);
    }
  });
});

describe("ArgsFailureTracker", () => {
  it.each(TRACKER_ROWS)("$name", ({ steps, levels }) => {
    expect(levelsOf(steps)).toEqual(levels);
  });
});

describe("buildRetryShape", () => {
  it.each(RETRY_ROWS)("$name", async (row) => {
    const localized = localizeFailingParam(row.error, row.sentArgs, row.schema);
    const shape = localized === undefined ? undefined : buildRetryShape(QUALIFIED, row.sentArgs, localized);
    const outcome: {
      path: readonly string[] | undefined;
      shape: { expr: string; menu?: string } | undefined;
      blindParses?: boolean;
      filledParses?: boolean;
    } = { path: localized?.path, shape };
    const want: typeof outcome = { path: row.path, shape: row.shape };
    if (row.blindParses !== undefined && shape !== undefined) {
      outcome.blindParses = await parsesAsOneForm(shape.expr);
      want.blindParses = row.blindParses;
    }
    if (row.filledSource !== undefined && shape !== undefined) {
      outcome.filledParses = await parsesAsOneForm(shape.expr.replace("#|string|#", row.filledSource));
      want.filledParses = true;
    }
    expect(outcome).toEqual(want);
  });
});

describe("renderArgsMisuseTeaching", () => {
  it.each(TEACH_ROWS)("$name", ({ error, body }) => {
    const localized = localizeFailingParam(error, undefined, DISCOVERY_SCHEMA);
    expect(
      localized === undefined
        ? undefined
        : renderArgsMisuseTeaching({
            qualifiedName: "git/git_log",
            sentArgs: undefined,
            localized,
            level: 1,
          }),
    ).toEqual(body);
  });
});
