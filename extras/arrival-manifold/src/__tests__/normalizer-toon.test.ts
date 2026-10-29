import { describe, expect, it } from "vitest";

import { parseToonStrict } from "../normalizer/toon.js";

describe("parseToonStrict — canonical tabular array", () => {
  it("decodes a tabular array field into an array of records", () => {
    const input = "users[2]{id,name}:\n  1,Alice\n  2,Bob";
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: {
        users: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      },
    });
  });
});

describe("parseToonStrict — hard gate 1: declared [N] must equal actual row count", () => {
  it("refuses when [N] declares more rows than are present (truncation gate)", () => {
    const input = "users[3]{id,name}:\n  1,Alice\n  2,Bob";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/declared length \[3\]/);
      expect(result.reason).toMatch(/actual row count 2/);
    }
  });

  it("refuses when [N] declares fewer rows than are present", () => {
    const input = "users[1]{id,name}:\n  1,Alice\n  2,Bob";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/declared length \[1\]/);
      expect(result.reason).toMatch(/actual row count 2/);
    }
  });
});

describe("parseToonStrict — hard gate 2: row arity must equal header arity", () => {
  it("refuses a row with too many fields", () => {
    const input = "users[2]{id,name}:\n  1,Alice,extra\n  2,Bob";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/row arity mismatch/);
      expect(result.reason).toMatch(/line 2/);
    }
  });

  it("refuses a row with too few fields", () => {
    const input = "users[2]{id,name}:\n  1\n  2,Bob";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/row arity mismatch/);
    }
  });
});

describe("parseToonStrict — hard gate 3: whole-string parse, no partial salvage", () => {
  it("refuses when content trails after a fully-consumed root-level array", () => {
    const input = "[1]{id,name}:\n  1,Alice\nnot part of the table";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/trailing content/);
    }
  });

  it("refuses orphaned indented content not attached to a header", () => {
    const input = "hello: world\n  stray indented line";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
  });
});

describe("parseToonStrict — hard gate 4: refuse rather than misparse plain text", () => {
  it("refuses plain prose", () => {
    const input = "The quick brown fox jumps over the lazy dog and keeps on running.";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
  });

  it("refuses a markdown table", () => {
    const input = "| Header1 | Header2 |\n| --- | --- |\n| Val1 | Val2 |";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
  });

  it("refuses empty input", () => {
    const result = parseToonStrict("");
    expect(result.ok).toBe(false);
  });

  it("refuses whitespace-only input", () => {
    const result = parseToonStrict("   \n   ");
    expect(result.ok).toBe(false);
  });
});

describe("parseToonStrict — scope decision: scalar-only ('YAML-lookalike') documents are refused", () => {
  // Per TOON spec §5, a document of nothing but `key: value` lines IS technically valid
  // TOON (root-form detection falls through to "object"). We deliberately refuse it
  // anyway: this module is a *recognizer* whose whole justification is structural
  // evidence that a blob genuinely is TOON, not incidental prose that happens to look
  // like `key: value`. Zero array constructs means zero of the signal TOON exists to
  // carry (tabular density) — see the module's "Scope decision" header comment, and
  // response-normalizer.md HARD GATE 4 / §4.1's CSV identifier-plausibility precedent.
  it("refuses a scalar-only key:value document even though the spec would accept it", () => {
    const input = "key: value\nother: thing";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no tabular\/array construct/);
    }
  });
});

describe("parseToonStrict — quoting: values containing the delimiter are preserved", () => {
  it("preserves a comma inside a quoted tabular cell", () => {
    const input = 'items[1]{note}:\n  "a, b, and more"';
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: { items: [{ note: "a, b, and more" }] },
    });
  });

  it("preserves escaped quotes and backslashes inside a quoted scalar field", () => {
    const input = String.raw`note: "she said \"hi\" and left\\"`;
    // no array construct present -> would be refused by the scope decision; add one to
    // keep this test isolated to the quoting behavior itself
    const withEvidence = `${input}\nitems[1]{x}:\n  1`;
    const result = parseToonStrict(withEvidence);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { note: string }).note).toBe('she said "hi" and left\\');
    }
  });
});

describe("parseToonStrict — one level of nested object", () => {
  it("decodes a nested object block alongside a tabular array", () => {
    const input = "context:\n  location: Boulder\n  season: spring\nusers[1]{id}:\n  1";
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: {
        context: { location: "Boulder", season: "spring" },
        users: [{ id: 1 }],
      },
    });
  });

  it("refuses a second level of nesting", () => {
    const input = "a:\n  b:\n    c: 1\nusers[1]{id}:\n  1";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
  });
});

describe("parseToonStrict — root-level array and primitive (inline) arrays", () => {
  it("decodes a root-level tabular array with no wrapping key", () => {
    const input = "[2]{id,name}:\n  1,Alice\n  2,Bob";
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    });
  });

  it("decodes an inline primitive array field", () => {
    const input = "tags[3]: red,green,blue";
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: { tags: ["red", "green", "blue"] },
    });
  });

  it("refuses an inline primitive array whose declared count doesn't match", () => {
    const input = "tags[3]: red,green";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/declared length \[3\]/);
    }
  });
});

describe("parseToonStrict — refused by design: expanded/list-style arrays", () => {
  it("refuses '- ' bullet-list array items", () => {
    const input = "tags[2]:\n  - red\n  - green";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/expanded list-style arrays/);
    }
  });
});

describe("parseToonStrict — alternate delimiters", () => {
  it("decodes a tab-delimited tabular array", () => {
    const input = "users[2\t]{id\tname}:\n  1\tAlice\n  2\tBob";
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: {
        users: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      },
    });
  });

  it("decodes a pipe-delimited tabular array", () => {
    const input = "users[2|]{id|name}:\n  1|Alice\n  2|Bob";
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: {
        users: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      },
    });
  });
});

describe("parseToonStrict — duplicate keys are refused", () => {
  it("refuses a duplicate top-level key", () => {
    const input = "a: 1\na: 2\nusers[1]{id}:\n  1";
    const result = parseToonStrict(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/duplicate key/);
    }
  });
});

describe("parseToonStrict — scalar type decoding", () => {
  it("decodes bare true/false/null/number tokens by type", () => {
    const input = "flags[1]{a,b,c,d}:\n  true,false,null,3.5";
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: { flags: [{ a: true, b: false, c: null, d: 3.5 }] },
    });
  });

  it("keeps a quoted numeric-looking string as a string, not a number", () => {
    const input = 'codes[1]{zip}:\n  "0123"';
    const result = parseToonStrict(input);
    expect(result).toEqual({
      ok: true,
      format: "toon",
      value: { codes: [{ zip: "0123" }] },
    });
  });
});
