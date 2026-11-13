import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  FileMutateToolJob,
  responseCall,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { recallContext } from "@inhuman.tools/turn/tool-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { asToolResult, SYSTEM_ENTRIES, ToolError, type ToolResult } from "@/builtin-tools";
import { historyBehind, policyOfTurn, stampJobRetention, stampRetentionClock, turnRetentionJson } from "@/context";
import { readConnectionSecrets } from "@/server/secrets";
import { bindSessionCatalog, KernelToolCatalog } from "@/tool-catalog";

import { viewWire, type ChatMessage } from "../actor.js";

const connection = process.env.ELISION_EVAL_CONNECTION;
const model = process.env.ELISION_EVAL_MODEL;
const configSchema = z.object({
  connections: z.record(z.string(), z.unknown()),
});
const connectionSchema = z.object({ settings: z.object({ baseUrl: z.string().url() }) });
const callSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().optional(),
          tool_calls: z.array(callSchema).optional(),
        }),
      }),
    )
    .min(1),
});
const argsSchema = z.record(z.string(), z.unknown());
const finalSchema = z.object({
  file: z.literal("plan.md"),
  source: z.enum(["generated", "recovered-original", "literal-quotation"]),
  verified: z.literal(true),
});
const marker = "[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]";
const quotation = `# History marker syntax\n\nAn example, quoted intentionally:\n\n\`${marker}\`\n`;
const original = `# Prior plan\n${Array.from(
  { length: 120 },
  (_, i) => `Step ${i}: ${randomBytes(6).toString("hex")} inspect, update, verify.\n`,
).join("")}`;
const cases = [
  {
    id: "new-plan",
    request:
      "Create plan.md with a new implementation plan for ORCHID-742 cache invalidation. Include Goal, Steps, and Verification sections. Write real content and verify the saved file by reading it before reporting completion.",
  },
  {
    id: "recover-original",
    request:
      "Create plan.md as an exact copy of the original prior.md contents from the previous turn. prior.md has since changed externally, so current file contents are not the original. Recover the original call arguments, including every page needed. Verify the saved copy by reading it before reporting completion.",
  },
  {
    id: "unreachable-ref",
    request:
      "First try context_recall for job:deadbeef#args. If it is unavailable, generate a NEW implementation plan for ORCHID-742 cache invalidation in plan.md, with Goal, Steps, and Verification sections. Verify the saved file by reading it. Do not claim to have recovered the unavailable original.",
  },
  {
    id: "intentional-quotation",
    request: `Create plan.md containing exactly this documentation example, including the literal marker. The marker is intentionally quoted text, not a request to recover content. Verify the saved file by reading it.\n\n${quotation}`,
  },
];

describe.skipIf(connection === undefined || model === undefined)("live elision behavior", () => {
  it.each(cases)(
    "$id: verifies the artifact and the tool evidence",
    async ({ id, request }) => {
      if (connection === undefined || model === undefined)
        throw new Error("Set ELISION_EVAL_CONNECTION and ELISION_EVAL_MODEL to run live cases.");
      const kernel = process.env.ELISION_EVAL_KERNEL ?? join(homedir(), ".harness");
      const config = configSchema.parse(JSON.parse(readFileSync(join(kernel, "config.json"), "utf8")));
      const configured = config.connections[connection];
      if (configured === undefined) throw new Error(`No configured connection ${connection}`);
      const settings = connectionSchema.parse(configured);
      const apiKey = readConnectionSecrets(kernel, connection).apiKey;
      const root = realpathSync(mkdtempSync(join(tmpdir(), "elision-behavior-")));
      const catalog = new KernelToolCatalog();
      catalog.replacePack(SYSTEM_ENTRIES);
      const plexus = SessionPlexus.create(`elision-${id}`, root);
      bindSessionCatalog(plexus.root, catalog);
      const toolNames = new Set(["write_file", "read_file", "context_recall"]);
      const tools = catalog
        .catalogEntries()
        .filter((entry) => toolNames.has(entry.wireName))
        .map((entry) => ({
          type: "function",
          function: { name: entry.wireName, description: entry.description, parameters: entry.parameters },
        }));
      const execute = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        if (name === "context_recall") return recallContext(plexus.root, args);
        if (
          !toolNames.has(name) ||
          (args.path !== "plan.md" && args.path !== "prior.md") ||
          (name === "write_file" && args.path !== "plan.md")
        ) {
          return { ok: false, text: "This evaluation permits reading prior.md and plan.md, and writing plan.md only." };
        }
        const body = catalog.catalogEntry(name)?.execute;
        if (body === undefined) throw new Error(`Missing builtin ${name}`);
        try {
          return asToolResult(await body(args, { root, catalog }));
        } catch (error) {
          if (error instanceof ToolError) return { ok: false, text: error.message };
          throw error;
        }
      };
      try {
        writeFileSync(join(root, "prior.md"), original);
        expect((await execute("read_file", { path: "prior.md" })).ok).toBe(true);
        const first = new SessionTurn({
          turnTail: new SessionSystemPrompt({
            constitution: prompt.system`Complete the user's file task with the provided tools. Report completed work only after the tool results support it. Your final reply must be JSON only: {"file":"plan.md","source":"generated"|"recovered-original"|"literal-quotation","verified":true}. Choose source according to what you actually did, and verified is true only after reading the final saved file.`,
          }),
          prompt: prompt.user`Write prior.md`,
          queue: [],
          retentionJson: turnRetentionJson("", {}),
        });
        plexus.root.seatHead(first);
        const prior = new CompletionExpectation({
          connectionId: connection,
          model,
          promptText: first.completionMessage,
          messages: historyBehind(first, { kv: {} }),
        });
        first.enqueue(new CompletionJob({ expectation: prior }));
        stampRetentionClock(prior, 1000);
        const args = JSON.stringify({ path: "prior.md", content: original });
        prior.setResponseCalls([responseCall("prior-write", "write_file", args)]);
        prior.responseText = "Wrote the prior plan.";
        first.take();
        const job = new FileMutateToolJob({
          toolCallId: "prior-write",
          name: "write_file",
          argsJson: args,
          completed: true,
          outcomeJson: JSON.stringify({ ok: true, text: `created prior.md (${original.length} bytes)` }),
        });
        stampJobRetention(job, policyOfTurn(first));
        first.enqueue(job);
        first.take();
        if (id === "recover-original")
          writeFileSync(join(root, "prior.md"), "Changed externally; this is not the original.\n");
        const next = new SessionTurn({
          turnTail: first,
          prompt: prompt.user`${request}`,
          queue: [],
          retentionJson: turnRetentionJson("", {}),
        });
        plexus.root.seatHead(next);
        const tip = new CompletionExpectation({
          connectionId: connection,
          model,
          promptText: next.completionMessage,
          messages: historyBehind(next, { kv: {} }),
        });
        next.enqueue(new CompletionJob({ expectation: tip }));
        stampRetentionClock(tip, 2000);
        const messages: ChatMessage[] = [...viewWire(tip)];
        expect(messages.flatMap((message) => message.tool_calls ?? [])).toHaveLength(0);
        expect(JSON.stringify(messages)).toContain("History abbreviation");
        expect(JSON.stringify(messages)).not.toContain('"content":"[elided:');
        const evidence: Array<{ name: string; args: Record<string, unknown>; ok: boolean }> = [];
        const recallRanges: Array<{ start: number; end: number; total: number }> = [];
        let finalReport: z.infer<typeof finalSchema> | null = null;
        for (let round = 0; round < 8; round++) {
          const response = await fetch(`${settings.settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({ model, messages, tools, stream: false, temperature: 0, max_tokens: 8192 }),
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) throw new Error(`Live provider returned HTTP ${response.status}`);
          const choice = responseSchema.parse(await response.json()).choices[0];
          const answer = choice.message;
          if (choice.finish_reason === "length")
            throw new Error(
              `Provider exhausted the output budget on round ${round + 1}; tools: ${evidence.map((call) => `${call.name}:${call.ok}`).join(", ")}; recall ranges: ${JSON.stringify(recallRanges)}`,
            );
          messages.push({
            role: "assistant",
            content: answer.content ?? null,
            ...(answer.tool_calls === undefined ? {} : { tool_calls: answer.tool_calls }),
            ...(answer.reasoning_content === undefined ? {} : { reasoning_content: answer.reasoning_content }),
          });
          if (answer.tool_calls === undefined || answer.tool_calls.length === 0) {
            if ((answer.content ?? "").trim() === "")
              throw new Error(
                `Provider returned an empty final message on round ${round + 1}; finish_reason=${choice.finish_reason ?? "absent"}, reasoningChars=${answer.reasoning_content?.length ?? 0}; completed tools: ${evidence.map((call) => call.name).join(", ")}`,
              );
            finalReport = finalSchema.parse(JSON.parse(answer.content ?? ""));
            break;
          }
          for (const call of answer.tool_calls) {
            const input = argsSchema.parse(JSON.parse(call.function.arguments));
            const outcome = await execute(call.function.name, input);
            evidence.push({ name: call.function.name, args: input, ok: outcome.ok });
            if (
              call.function.name === "context_recall" &&
              input.ref === `job:${job.uuid.slice(0, 8)}#args` &&
              outcome.ok &&
              typeof outcome.value === "string"
            ) {
              const range = /: chars (\d+)-(\d+) of (\d+),/.exec(outcome.value);
              if (range !== null)
                recallRanges.push({ start: Number(range[1]), end: Number(range[2]), total: Number(range[3]) });
            }
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome) });
          }
        }
        const source =
          id === "recover-original"
            ? "recovered-original"
            : id === "intentional-quotation"
              ? "literal-quotation"
              : "generated";
        expect(finalReport, "model must finish with a source claim matching the actual artifact").toEqual({
          file: "plan.md",
          source,
          verified: true,
        });
        const saved = readFileSync(join(root, "plan.md"), "utf8");
        const wrote = evidence.findLastIndex(
          (call) => call.name === "write_file" && call.args.path === "plan.md" && call.ok,
        );
        const verified = evidence.findIndex(
          (call, index) => index > wrote && call.name === "read_file" && call.args.path === "plan.md" && call.ok,
        );
        expect(wrote).toBeGreaterThanOrEqual(0);
        expect(verified, "completion requires a read after writing").toBeGreaterThan(wrote);
        if (id === "intentional-quotation") expect(saved).toBe(quotation);
        else {
          expect(saved).not.toContain("[elided:");
          if (id === "recover-original") {
            expect(saved).toBe(original);
            let covered = 0;
            for (const range of recallRanges.toSorted((a, b) => a.start - b.start)) {
              expect(range.total).toBe(args.length);
              expect(range.start, "recall pages must not leave a gap").toBeLessThanOrEqual(covered);
              covered = Math.max(covered, range.end);
            }
            expect(covered).toBe(args.length);
          } else {
            expect(saved.length).toBeGreaterThan(120);
            for (const word of ["ORCHID-742", "Goal", "Steps", "Verification"]) expect(saved).toContain(word);
          }
          if (id === "unreachable-ref")
            expect(
              evidence.some(
                (call) => call.name === "context_recall" && call.args.ref === "job:deadbeef#args" && !call.ok,
              ),
            ).toBe(true);
        }
        // eslint-disable-next-line no-console -- live evaluation evidence, never credentials or document bodies
        console.log({
          case: id,
          model,
          calls: evidence.map((call) => `${call.name}:${call.ok}`),
          artifactChars: saved.length,
          finalReport,
        });
      } finally {
        plexus.destroy();
        catalog[Symbol.dispose]();
        rmSync(root, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
