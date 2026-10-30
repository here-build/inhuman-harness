/**
 * `--connection` / `--model` resolve copy. Unique production failure: the
 * operator sees the wrong connection, or an error that does not name the
 * colliding providers.
 */
import { expect, it } from "vitest";

import { resolveAgent, unsupportedAgentFlagsError } from "../model-flags.js";

const grok = {
  id: "grok",
  name: "Grok",
  driver: "grok",
  abilityClaim: ["completion", "web-search"],
  enabled: true,
};
const openai = {
  id: "openai",
  name: "OpenAI",
  driver: "openai-compat",
  abilityClaim: ["completion"],
  enabled: true,
};
const github = {
  id: "github",
  name: "GitHub",
  driver: "mcp-stdio",
  abilityClaim: ["mcp"],
  enabled: true,
};
const parked = {
  id: "parked",
  name: "Parked",
  driver: "openai-compat",
  abilityClaim: ["completion"],
  enabled: false,
};
const studio = {
  id: "lm-studio",
  name: "LM Studio",
  driver: "openai-compat",
  abilityClaim: ["completion"],
  enabled: true,
};

const catalogs = [
  { id: "grok", models: ["grok-4", "grok-4.6"], error: "" },
  { id: "openai", models: ["gpt-4", "grok-4"], error: "" },
  { id: "lm-studio", models: ["qwen/qwen3.8-27b"], error: "" },
];

it.each([
  {
    name: "connection only",
    flags: { connection: "grok" },
    catalogs: undefined,
    want: { ok: true, agent: { connection: "grok" } },
  },
  {
    name: "unique model",
    flags: { model: "gpt-4" },
    catalogs,
    want: { ok: true, agent: { connection: "openai", model: "gpt-4" } },
  },
  {
    name: "scoped model",
    flags: { connection: "grok", model: "grok-4" },
    catalogs,
    want: { ok: true, agent: { connection: "grok", model: "grok-4" } },
  },
  {
    name: "slashed model id is literal",
    flags: { model: "qwen/qwen3.8-27b" },
    catalogs,
    want: { ok: true, agent: { connection: "lm-studio", model: "qwen/qwen3.8-27b" } },
  },
  {
    name: "unknown connection names providers",
    flags: { connection: "foo" },
    catalogs: undefined,
    want: {
      ok: false,
      error: [
        'unknown connection "foo".',
        "Completion connections: grok, lm-studio, openai.",
        "MCP connections: github.",
      ].join("\n"),
    },
  },
  {
    name: "mcp connection is not completion",
    flags: { connection: "github" },
    catalogs: undefined,
    want: {
      ok: false,
      error: [
        'connection "github" is not a completion connection (mcp-stdio).',
        "Completion connections: grok, lm-studio, openai.",
      ].join("\n"),
    },
  },
  {
    name: "disabled connection",
    flags: { connection: "parked" },
    catalogs: undefined,
    want: { ok: false, error: 'connection "parked" is disabled.' },
  },
  {
    name: "model missing on connection names the catalog",
    flags: { connection: "grok", model: "gpt-4" },
    catalogs,
    want: {
      ok: false,
      error: ['model "gpt-4" is not available on connection "grok".', "Models on grok: grok-4, grok-4.6."].join("\n"),
    },
  },
  {
    name: "ambiguous names both providers",
    flags: { model: "grok-4" },
    catalogs,
    want: {
      ok: false,
      error: [
        'model "grok-4" is available on multiple connections: grok, openai.',
        "Pass --connection to pick one.",
      ].join("\n"),
    },
  },
  {
    name: "missing across names searched catalogs",
    flags: { model: "nope" },
    catalogs,
    want: {
      ok: false,
      error: [
        'model "nope" was not found on any completion connection.',
        "Searched: grok (grok-4, grok-4.6); openai (gpt-4, grok-4); lm-studio (qwen/qwen3.8-27b).",
      ].join("\n"),
    },
  },
  {
    name: "slashed model scoped to the named connection",
    flags: { connection: "lm-studio", model: "qwen/qwen3.8-27b" },
    catalogs,
    want: { ok: true, agent: { connection: "lm-studio", model: "qwen/qwen3.8-27b" } },
  },
] as const)("resolveAgent $name", ({ flags, catalogs: face, want }) => {
  expect(
    resolveAgent({
      flags,
      connections: [grok, openai, github, parked, studio],
      ...(face === undefined ? {} : { catalogs: face }),
    }),
  ).toEqual(want);
});

it("unsupported verbs name the command", () => {
  expect(unsupportedAgentFlagsError("inhuman mcp add")).toMatch(/inhuman mcp add[\s\S]*does not select a model/);
});
