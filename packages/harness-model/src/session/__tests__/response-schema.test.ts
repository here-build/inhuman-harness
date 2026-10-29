import { prompt } from "@inhuman.tools/harness-commons";
import { describe, expect, it } from "vitest";

import { CompletionExpectation } from "../expectations/CompletionExpectation.js";
import { assertResponseMatchesSchema, isJsonSchemaUnsupported } from "../expectations/response-schema.js";

const schemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "uncertainty"],
  properties: {
    decision: { type: "string", enum: ["allow", "deny", "abstain"] },
    uncertainty: { type: "integer", minimum: 1, maximum: 9 },
  },
};
const schema = JSON.stringify(schemaObject);

describe("response schema", () => {
  it("rejects bounds, enum, extras, and non-JSON; illegal succeed keeps the completion", () => {
    const ok = (() => {
      try {
        assertResponseMatchesSchema(JSON.stringify({ decision: "allow", uncertainty: 1 }), schema);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.message : "threw";
      }
    })();
    const minimum = (() => {
      try {
        assertResponseMatchesSchema(JSON.stringify({ decision: "allow", uncertainty: -100 }), schema);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.message : "threw";
      }
    })();
    const en = (() => {
      try {
        assertResponseMatchesSchema(JSON.stringify({ decision: "maybe", uncertainty: 1 }), schema);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.message : "threw";
      }
    })();
    const extra = (() => {
      try {
        assertResponseMatchesSchema(JSON.stringify({ decision: "allow", uncertainty: 1, extra: true }), schema);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.message : "threw";
      }
    })();
    const notJson = (() => {
      try {
        assertResponseMatchesSchema("sure, here:\n```json\n{nope}\n```", schema);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.message : "threw";
      }
    })();
    const empty = (() => {
      try {
        assertResponseMatchesSchema("", schema);
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.message : "threw";
      }
    })();
    const node = new CompletionExpectation({
      connectionId: "c1",
      promptText: prompt.user`x`,
      responseSchema: schemaObject,
    });
    const badText = JSON.stringify({ decision: "allow", uncertainty: -100 });
    const sealed = node.succeed("settled", "", "null", {
      result: { text: badText, thought: "because" },
    });
    expect({
      ok,
      minimum: /minimum/.test(minimum),
      enum: /enum/.test(en),
      extra: /extra field/.test(extra),
      notJson,
      empty,
      pew: {
        sealed,
        outcome: node.outcome,
        detail: node.endDetail != null && node.endDetail.startsWith("apply_error:"),
        text: node.responseText,
        thought: node.responseThought,
      },
      unsupported: isJsonSchemaUnsupported("json_schema unsupported: responses API"),
    }).toEqual({
      ok: "ok",
      minimum: true,
      enum: true,
      extra: true,
      notJson: 'response schema: completion is not JSON ("sure, here: ```json {nope} ```")',
      empty: "response schema: completion is not JSON (empty)",
      pew: { sealed: true, outcome: "failed", detail: true, text: badText, thought: "because" },
      unsupported: true,
    });
  });
});
