import { PlexusModel, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, expect, test } from "vitest";

import { CompletionExpectation } from "../expectations/CompletionExpectation.js";
import { McpToolExpectation } from "../expectations/McpToolExpectation.js";
import { ResponseCall } from "../expectations/ResponseCall.js";
import { BotCallJob } from "../jobs/BotCallJob.js";
import { SuccessfulOutcome } from "../jobs/CallOutcome.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { ToolSpec } from "../prompt-parts.js";

beforeEach(() => resetLocalIDs());

test("a null record face stores null, and {} stores {}", () => {
  const tool = new SystemToolJob({ toolCallId: "t", name: "shell", argsJson: '{"command":"ls"}' });
  const program = new ProgrammaticJob({ toolCallId: "p", argsJson: '{"expr":"1"}' });
  const response = new ResponseCall({ toolCallId: "r", name: "shell", argsJson: '{"command":"ls"}' });
  const mcp = new McpToolExpectation({ connectionId: "c", argsJson: '{"q":1}' });
  const spec = new ToolSpec({ name: "shell", argsJson: '{"type":"object"}' });
  const pew = new CompletionExpectation({
    connectionId: "c",
    promptText: prompt.user`x`,
    responseSchema: { type: "object" },
  });

  tool.args = null;
  program.args = null;
  response.args = null;
  mcp.args = null;
  spec.parameters = null;
  pew.responseSchema = null;
  spec.parameters = {};

  expect({
    tool: Reflect.get(tool, "argsJson"),
    program: Reflect.get(program, "argsJson"),
    response: Reflect.get(response, "argsJson"),
    mcp: Reflect.get(mcp, "argsJson"),
    cleared: Reflect.get(pew, "responseSchemaJson"),
    spec: Reflect.get(spec, "argsJson"),
    toolFace: tool.args,
    schema: pew.responseSchema,
    specFace: spec.parameters,
  }).toEqual({
    tool: null,
    program: null,
    response: null,
    mcp: null,
    cleared: null,
    spec: "{}",
    toolFace: null,
    schema: null,
    specFace: {},
  });
});

test("a rehydrated call reads an empty response schema", () => {
  const job = PlexusModel.__materializeRaw__(BotCallJob);
  expect(job.responseSchema).toBeNull();
  job.responseSchema = { type: "object" };
  expect({ face: job.responseSchema, cell: Reflect.get(job, "responseSchemaJson") }).toEqual({
    face: { type: "object" },
    cell: '{"type":"object"}',
  });
});

test("blank and the string null read as no record", () => {
  const blank = new SystemToolJob({ toolCallId: "b", name: "shell", argsJson: "" });
  const word = new SystemToolJob({ toolCallId: "n", name: "shell", argsJson: "null" });
  const empty = new SystemToolJob({ toolCallId: "e", name: "shell", argsJson: "{}" });
  expect({ blank: blank.args, word: word.args, empty: empty.args }).toEqual({
    blank: null,
    word: null,
    empty: {},
  });
  expect(Reflect.get(blank, "argsJson")).toBe("");
});

test("a null outcome value stores a null cell", () => {
  const outcome = new SuccessfulOutcome({ valueJson: '"ok"' });
  outcome.value = null;
  expect(outcome.value).toBeNull();
  expect(outcome.valueText()).toBe("");
  expect(Reflect.get(outcome, "valueJson")).toBeNull();

  const legacy = new SuccessfulOutcome({ valueJson: "null" });
  expect(legacy.value).toBeNull();
  expect(legacy.valueText()).toBe("null");
});

test('a null prepare is no document; legacy "null" still is', () => {
  const bot = new BotCallJob({ botName: "b", toolCallId: "b" });
  expect(bot.acceptPreparedInput(null, "w")).toBe(true);
  expect(bot.preparedDocument).toBe(false);
  expect(bot.preparedInput).toBeNull();

  const legacy = new BotCallJob({ botName: "old", toolCallId: "old", preparedInputJson: "null" });
  expect(legacy.preparedDocument).toBe(true);
  expect(legacy.preparedInput).toBeNull();
});
