/**
 * Chunk-split invariance.
 *
 *   assembleEvents(session.ingest/close(chunks)) === normalizeMessage(whole)
 *
 * A handful of cuts per input: one whole chunk, one character at a time,
 * one seeded split, one open-marker interior, one close-marker interior.
 * Corpus items that set `valueNeedles` also cut through each of those
 * needles — the regression where a close marker sits inside an argument
 * value (LongCat `</longcattoolcall>` / `</longcat_arg_value>`, Qwen
 * `</function>` / `</parameter>`).
 *
 * `idStyle: "stable"` compares tool ids too (same content-hash mint on
 * both paths).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ensureBuiltins,
  normalizeMessage,
  assembleEvents,
  getDialect,
  type NormalizeOptions,
  type ToolCall,
} from "../index.js";
import { listFixtureFiles } from "./harness.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { collectEvents } from "./stream-harness.js";

ensureBuiltins();

// ---------------------------------------------------------------------------
// Seeded LCG — deterministic, reproducible, NOT Math.random.
// ---------------------------------------------------------------------------

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Chop `input` into pseudo-random chunk lengths (1..2*avgLen-1), seeded. */
function randomSplit(input: string, seed: number, avgLen: number): string[] {
  const rand = makeLcg(seed);
  const chunks: string[] = [];
  let i = 0;
  while (i < input.length) {
    const len = Math.max(1, Math.floor(rand() * (avgLen * 2 - 1)) + 1);
    chunks.push(input.slice(i, i + len));
    i += len;
  }
  return chunks.length > 0 ? chunks : [input];
}

type SplitCase = { label: string; chunks: string[] };

/** Midpoint of each `needle` occurrence, strictly inside the string. */
function midpointCuts(input: string, needle: string, maxOccurrences: number): number[] {
  if (!needle) return [];
  const cuts: number[] = [];
  let idx = input.indexOf(needle);
  let seen = 0;
  while (idx >= 0 && seen < maxOccurrences) {
    const cut = idx + Math.max(1, Math.floor(needle.length / 2));
    if (cut > 0 && cut < input.length) cuts.push(cut);
    idx = input.indexOf(needle, idx + needle.length);
    seen++;
  }
  return cuts;
}

function twoWay(input: string, label: string, cut: number): SplitCase {
  return { label, chunks: [input.slice(0, cut), input.slice(cut)] };
}

function dialectMarkers(dialectId: string | undefined): { open: string[]; close: string[] } {
  if (!dialectId || dialectId === "auto") return { open: [], close: [] };
  const d = getDialect(dialectId);
  if (!d) return { open: [], close: [] };
  return {
    open: d.openMarkers?.length ? d.openMarkers : d.markers,
    close: d.closeMarkers ?? [],
  };
}

/**
 * Handful of cuts, plus one midpoint per value-needle occurrence (close
 * marker sitting inside a value).
 */
function buildSplits(input: string, opts: NormalizeOptions, valueNeedles: string[] = []): SplitCase[] {
  const { open, close } = dialectMarkers(opts.dialect);
  const splits: SplitCase[] = [
    { label: "single-whole-chunk", chunks: [input] },
    { label: "one-character-at-a-time", chunks: [...input] },
    { label: "lcg-seed-1", chunks: randomSplit(input, 1, 3) },
  ];
  const openCut = midpointCuts(input, open.find((m) => input.includes(m)) ?? "", 1)[0];
  if (openCut !== undefined) splits.push(twoWay(input, "open-marker-interior", openCut));
  const closeCut = midpointCuts(input, close.find((m) => input.includes(m)) ?? "", 1)[0];
  if (closeCut !== undefined) splits.push(twoWay(input, "close-marker-interior", closeCut));
  for (const needle of valueNeedles) {
    for (const cut of midpointCuts(input, needle, 4)) {
      splits.push(twoWay(input, `close-in-value:${JSON.stringify(needle)}@${cut}`, cut));
    }
  }
  return splits;
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

type CorpusItem = {
  id: string;
  input: string;
  opts: NormalizeOptions;
  /** Substrings inside an argument VALUE worth cutting through explicitly. */
  valueNeedles?: string[];
};

/** Reuse src/__tests__/fixtures/** — string-`input` cases only (object/native
 * `tool_calls` inputs aren't meaningful to re-chunk as an SSE text stream). */
function fixtureCorpus(): CorpusItem[] {
  const out: CorpusItem[] = [];
  for (const path of listFixtureFiles()) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      id?: string;
      input?: unknown;
      opts?: NormalizeOptions;
      chunks?: string[];
    };
    if (typeof raw.input !== "string" || raw.chunks) continue;
    out.push({ id: `fixture:${raw.id ?? path}`, input: raw.input, opts: raw.opts ?? {} });
  }
  return out;
}

/** Gap corpus (task C2): dialects/inputs not covered by the JSON fixtures,
 * plus the two explicitly-requested gap cases (close marker inside an
 * argument value, for both LongCat and Qwen). */
const gapCorpus: CorpusItem[] = [
  {
    id: "longcat json body",
    input:
      "Ok.\n<longcat_tool_call>\n" + '{"name": "read_file", "arguments": {"path": "a.ts"}}\n' + "</longcat_tool_call>",
    opts: { dialect: "longcat" },
  },
  {
    id: "longcat multi block",
    input:
      "<longcat_tool_call>\n" +
      '{"name":"read_file","arguments":{"path":"a"}}\n' +
      "</longcat_tool_call><longcat_tool_call>\n" +
      '{"name":"read_file","arguments":{"path":"b"}}\n' +
      "</longcat_tool_call>",
    opts: { dialect: "longcat" },
  },
  {
    id: "qwen bare function=",
    input: "Looking up.\n<function=read_file>\n<parameter=path>\na.ts\n</parameter>\n</function>",
    opts: { dialect: "qwen_xml", tools: [{ name: "read_file" }] },
  },
  {
    id: "qwen wrapped tool_call+function",
    input:
      "Ok.\n<tool_call>\n<function=write_file>\n<parameter=path>\nx.py\n</parameter>\n" +
      "<parameter=content>\nprint(1)\n</parameter>\n</function>\n</tool_call>",
    opts: { dialect: "qwen_xml" },
  },
  {
    id: "hermes two calls with prose between",
    input:
      'a <tool_call>{"name":"x","arguments":{}}</tool_call> mid ' +
      '<tool_call>{"name":"y","arguments":{}}</tool_call> end',
    opts: { dialect: "hermes" },
  },
  {
    id: "hermes stable ids",
    input: "I'll check.\n<tool_call>\n" + '{"name": "get_weather", "arguments": {"city": "NYC"}}\n</tool_call>',
    opts: { dialect: "hermes", idStyle: "stable" },
  },
  // --- gap: close marker appearing INSIDE an argument value ---------------
  {
    id: "GAP longcat: </longcat_arg_value> literal inside the value it closes",
    input:
      "<longcat_tool_call>\n" +
      "write_file\n" +
      "<longcat_arg_key>path</longcat_arg_key>\n" +
      "<longcat_arg_value>a.ts</longcat_arg_value>\n" +
      "<longcat_arg_key>content</longcat_arg_key>\n" +
      "<longcat_arg_value>see </longcat_arg_value> embedded</longcat_arg_value>\n" +
      "</longcat_tool_call>",
    opts: {
      dialect: "longcat",
      tools: [
        {
          name: "write_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
          },
        },
      ],
    },
    valueNeedles: ["</longcat_arg_value>"],
  },
  {
    id: "GAP qwen: </parameter> literal inside the value it closes",
    input:
      "<function=write_file>\n" +
      "<parameter=path>x.py</parameter>\n" +
      "<parameter=content>see </parameter> embedded</parameter>\n" +
      "</function>",
    opts: { dialect: "qwen_xml", tools: [{ name: "write_file" }] },
    valueNeedles: ["</parameter>"],
  },
];

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toolShape(tc: ToolCall, includeId: boolean) {
  return {
    id: includeId ? tc.id : undefined,
    name: tc.function.name,
    arguments: parseArgs(tc.function.arguments),
  };
}

function assembleStream(chunks: string[], opts: NormalizeOptions) {
  return assembleEvents(collectEvents(chunks, opts), { dropPartials: false });
}

/** assembleEvents(createStreamSession ingest/close) vs normalizeMessage(whole). */
async function assertLaw(input: string, opts: NormalizeOptions, chunks: string[], label: string): Promise<void> {
  resetRegistryForTests();
  ensureBuiltins();
  const batch = normalizeMessage(input, opts);

  resetRegistryForTests();
  ensureBuiltins();
  const assembled = assembleStream(chunks, opts);

  const includeId = opts.idStyle === "stable";
  expect(
    assembled.tool_calls.map((t) => toolShape(t, includeId)),
    `${label} tool_calls`,
  ).toEqual(batch.tool_calls.map((t) => toolShape(t, includeId)));
  expect(assembled.content, `${label} content`).toBe(batch.content);
  expect(assembled.finish_reason, `${label} finish_reason`).toBe(batch.finish_reason);
  expect(assembled.meta.partial, `${label} meta.partial`).toEqual(batch.meta.partial);
}

describe("chunk-split invariance: assemble(stream(any split)) === batch(whole)", () => {
  const corpus = [...fixtureCorpus(), ...gapCorpus];

  for (const item of corpus) {
    it(item.id, async () => {
      for (const { label, chunks } of buildSplits(item.input, item.opts, item.valueNeedles)) {
        await assertLaw(item.input, item.opts, chunks, label);
      }
    });
  }
});
