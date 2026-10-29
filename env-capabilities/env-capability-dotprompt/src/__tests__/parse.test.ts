import { exec } from "@here.build/arrival";
import dedent from "dedent";
import { describe, expect, it } from "vitest";

import { dotpromptCapability } from "../capability.js";
import { ParsedPrompt } from "../parse.js";

function isParser(v: unknown): v is (src: string, path: string) => Promise<unknown> {
  return typeof v === "function";
}

const parse = exec("dotprompt/parse", { capabilities: [dotpromptCapability] }).then(([fn]) => {
  if (!isParser(fn)) throw new Error("dotprompt/parse is not a procedure");
  return fn;
});

async function parsed(src: string, path: string): Promise<ParsedPrompt> {
  const unit = await (await parse)(src, path);
  if (!(unit instanceof ParsedPrompt)) throw new Error("dotprompt/parse did not return a ParsedPrompt");
  return unit;
}

describe("dotprompt/parse", () => {
  it("splits roles and records structured output", async () => {
    const src = dedent`
      ---
      model: test-model
      output:
        decision: string
      ---
      {{role "system"}}
      Be brief.
      {{role "user"}}
      Hello {{evidence}}
    `;
    const unit = await parsed(src, "c.prompt");
    expect(unit).toMatchObject({
      mode: "chat",
      model: "test-model",
    });
    expect(unit.responseSchema).toEqual({
      type: "object",
      properties: { decision: { type: "string" } },
      required: ["decision"],
      additionalProperties: false,
    });
    expect(unit.sections.map((s) => s.role)).toEqual(["system", "user"]);
    expect(unit.sections[1]?.source).toContain("{{evidence}}");
  });

  it("an unstructured body without frontmatter is chat", async () => {
    const unit = await parsed(
      dedent`
        {{role "user"}}
        Say hi.
      `,
      "hi.prompt",
    );
    expect({ model: unit.model, mode: unit.mode, schema: unit.responseSchema }).toEqual({
      model: null,
      mode: "chat",
      schema: null,
    });
  });

  it("passes a JSON Schema output map through", async () => {
    const src = dedent`
      ---
      output:
        type: object
        additionalProperties: false
        required: [uncertainty]
        properties:
          uncertainty:
            type: integer
            minimum: 1
            maximum: 9
            description: verbalized unsureness
      ---
      {{role "user"}}
      x
    `;
    const unit = await parsed(src, "c.prompt");
    expect(unit.responseSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["uncertainty"],
      properties: {
        uncertainty: {
          type: "integer",
          minimum: 1,
          maximum: 9,
          description: "verbalized unsureness",
        },
      },
    });
  });

  it("compiles enum and a described integer", async () => {
    const src = dedent`
      ---
      output:
        decision(enum): [allow, deny, abstain]
        uncertainty: integer, verbalized unsureness
      ---
      {{role "user"}}
      x
    `;
    const unit = await parsed(src, "c.prompt");
    expect(unit.responseSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["decision", "uncertainty"],
      properties: {
        decision: { enum: ["allow", "deny", "abstain"] },
        uncertainty: { type: "integer", description: "verbalized unsureness" },
      },
    });
  });

  it("rejects unsupported execution frontmatter", async () => {
    await expect(
      parsed(
        dedent`
          ---
          agent: reviewer
          ---
          {{role "user"}}
          x
        `,
        "a.prompt",
      ),
    ).rejects.toThrow(/agent:/);
    await expect(
      parsed(
        dedent`
          ---
          mcp: true
          ---
          {{role "user"}}
          x
        `,
        "m.prompt",
      ),
    ).rejects.toThrow(/mcp:/);
    await expect(
      parsed(
        dedent`
          ---
          fallbackModels: [a]
          ---
          {{role "user"}}
          x
        `,
        "f.prompt",
      ),
    ).rejects.toThrow(/fallbackModels:/);
  });

  it("records tools overlay and face name from frontmatter or path stem", async () => {
    const stemmed = await parsed(
      dedent`
        ---
        tools: [read_file]
        ---
        {{role "user"}}
        x
      `,
      "analyze.prompt",
    );
    const named = await parsed(
      dedent`
        ---
        name: classify
        ---
        {{role "user"}}
        x
      `,
      "anonymous.prompt",
    );
    const inherit = await parsed(
      dedent`
        {{role "user"}}
        x
      `,
      "anonymous.prompt",
    );
    const blank = await parsed(
      dedent`
        ---
        name: "  "
        ---
        {{role "user"}}
        x
      `,
      "analyze.prompt",
    );
    expect({
      stemmed: { faceName: stemmed.faceName, tools: stemmed.tools },
      named: named.faceName,
      inherit: { faceName: inherit.faceName, tools: inherit.tools },
      blank: blank.faceName,
    }).toEqual({
      stemmed: { faceName: "analyze", tools: ["read_file"] },
      named: "classify",
      inherit: { faceName: "prompt", tools: null },
      blank: "analyze",
    });
  });

  it("treats a blank model as absent", async () => {
    const unit = await parsed(
      dedent`
        ---
        model: ""
        ---
        {{role "user"}}
        x
      `,
      "m.prompt",
    );
    expect(unit.model).toBeNull();
  });

  it("keeps reasoningEffort unused", async () => {
    const unit = await parsed(
      dedent`
        ---
        reasoningEffort: high
        ---
        {{role "user"}}
        x
      `,
      "r.prompt",
    );
    expect(unit.model).toBeNull();
  });
});

it("validates canonical reasoning effort metadata", async () => {
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const unit = await parsed(
      dedent`
        ---
        reasoningEffort: ${effort}
        ---
        {{role "user"}}
        hi
      `,
      "r.prompt",
    );
    expect(unit.reasoningEffort).toBe(effort);
  }
  const omitted = await parsed(
    dedent`
      {{role "user"}}
      hi
    `,
    "r.prompt",
  );
  expect(omitted.reasoningEffort).toBeNull();
  for (const effort of ["bogus", "HIGH", "42", "true"]) {
    await expect(
      parsed(
        dedent`
          ---
          reasoningEffort: ${effort}
          ---
          {{role "user"}}
          hi
        `,
        "r.prompt",
      ),
    ).rejects.toThrow(/reasoningEffort/);
  }
});
