import { SCHEME_REPL_TOOL_NAME } from "@inhuman.tools/harness-model";
import { schemeReplDescription, oneShotModelError, parseModelRef } from "@inhuman.tools/harness-scheme";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import { schemeWatchTool } from "@/builtin-tools";

import { openAiTools } from "../../toolkit/catalog.js";
import { KernelToolCatalog } from "../../toolkit/tool-table.js";

describe("schemeReplDescription", () => {
  it("CHARACTERIZE dump: live signatures, no unbound domains, no tasks/list; models enumerate/recency", () => {
    const catalog = new KernelToolCatalog();
    catalog.connectionHost = {
      connectionEntries: [
        {
          wireName: "mcp__mail__search",
          description: "search mail",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
          class: "read",
          source: { kind: "connection", connectionKey: "mail", serverToolName: "search" },
        },
      ],
    };
    const models = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const faces = {
      connections: [
        { id: "openai", models: ["chatgpt-5.6-luna"] },
        { id: "openrouter", models },
      ],
      modelsUsage: { "openrouter/m0": 1 },
    };
    const unused = Array.from({ length: 147 }, (_, i) => `m${i}`);
    unused[0] = "kimi-k3";
    unused[1] = "qwen-3.8";
    const small = { id: "openai", models: ["chatgpt-5.6-luna", "chatgpt-5.6-terra"] };
    const openaiSpec = new ConnectionSpec({ driver: new DriverSpec({ abilityClaim: ["completion"] }), name: "openai" });
    openaiSpec.live = { models: small.models };
    const large = { id: "openrouter", models: unused };
    const empty = { id: "grok", models: [] as string[] };
    const live = schemeReplDescription(catalog, faces);
    const recency = schemeReplDescription(catalog, {
      connections: [small, large, empty],
      modelsUsage: {
        "openrouter/kimi-k3": 20,
        "openrouter/qwen-3.8": 10,
        "openrouter/retired": 30,
      },
    });
    const tools = openAiTools(catalog);
    const relevant = tools.filter(
      (tool) => tool.function.name === SCHEME_REPL_TOOL_NAME || tool.function.name.startsWith("task__"),
    );
    const validate = relevant.find((tool) => tool.function.name === "task__validate");
    const watch = tools.find((tool) => tool.function.name === "scheme_watch");

    expect({
      help: {
        watch: schemeWatchTool.description,
        frozen: catalog.catalogEntry(SCHEME_REPL_TOOL_NAME)?.description,
        validate: validate?.function.description,
        watchProjected: watch?.function.description,
      },
      live: {
        positional: live.includes("(read_file path)"),
        grep: live.includes("(grep pattern"),
        kwargs: live.includes("(web_search query :numResults") && live.includes(":overwriteExisting #t"),
        grepKwargs: live.includes("(grep pattern :path") && live.includes(':glob "*.ts"'),
        mcp: live.includes("(mcp/call 'mail 'search args)"),
        span: live.includes("The functions below span") && live.includes("mail"),
        filesKind: /files|repositories/i.test(live),
        github: live.includes("github"),
        named: live.includes("quick-search") && live.includes("Bots —"),
        swarm: live.includes(
          '(map (lambda (path) (agent/ask \'quick-search (string-append "who imports " path))) (glob "src/**/*.ts"))',
        ),
        programOnce: live.includes("program once"),
        unwrap: live.includes("Do not wrap them in (begin"),
        smallFace: live.includes("openai — openai/chatgpt-5.6-luna"),
        largeFace: live.includes("openrouter — openrouter/m0, and 11 more"),
        hint: live.includes("(connection/models 'openrouter)"),
        wireMcp: live.includes("(mcp/call 'mail 'search args)"),
        handwrittenList: /tasks\/(?:list|get)/.test(
          `${catalog.catalogEntry(SCHEME_REPL_TOOL_NAME)?.description ?? ""}\n${live}`,
        ),
        jargon:
          /\b(?:BODY|joinReleased|ReACT|limbo|sitter|minted)\b|bag-home|teaching door|notebook page|frozen.*exam/i.test(
            JSON.stringify(relevant),
          ),
        relevantNames: relevant.map((tool) => tool.function.name),
        validateHidden: /hidden|invisible|limbo/i.test(validate?.function.description ?? ""),
      },
      models: {
        ref: parseModelRef("openrouter/anthropic/claude"),
        bad: parseModelRef("openai"),
        pin: oneShotModelError("openai/chatgpt-5.6-luna", { openai: openaiSpec }),
        ghost: oneShotModelError("openai/nope", { openai: openaiSpec }),
        inventory: recency.includes(
          [
            "Available models:",
            "grok",
            "openai — openai/chatgpt-5.6-luna, /chatgpt-5.6-terra",
            "openrouter — openrouter/kimi-k3, openrouter/qwen-3.8, and 145 more",
            "to get the list with names of all models available for a specific connection, use (connection/models 'openrouter)",
          ].join("\n"),
        ),
      },
    }).toEqual({
      help: {
        watch: `Monitor over time by re-evaluating a sandboxed Scheme program at the required period. \`description\` is optional and must be one line when set — the transcript shows it in place of the program, which is only visible on expand. Omit it and the program is the collapsed row. Use only when the user requests ongoing monitoring or repeated checks, for example watching GitHub comments for new activity. Use scheme_repl for one-shot work, including agent requests; background execution alone does not require a watcher. The harness schedules checks without a new model turn per check, saving context and tokens compared with a conversational loop.
All scheme_repl symbols, tools, calling conventions, and worker APIs are available here; see scheme_repl for their shared definitions and live catalog. Watcher-only additions:
(meta-reactivity/done-condition pred [result]) ends the watcher when pred is true. Each iteration must call it on a reachable path; quoted forms, unapplied lambdas, and unreachable branches do not count. Use a predicate matching the requested stopping condition, not constant true just to satisfy validation. For ongoing monitoring until cancelled, use #f.
(meta-reactivity/added|removed|changed list [:identity fn]) tracks differences across iterations.
Use the shared (self/notify message) to send an update without ending the watcher. For “wake me when something new appears,” notify on the event and then set the done condition true. For “keep notifying me about new comments,” notify on new events and keep the done condition false. Use background: true for notifications to arrive in the conversation while monitoring continues; inside a worker request, updates attach to that request.
Each iteration runs in a fresh Scheme scope; reactivity state persists across iterations. There is no inner-call or time limit unless maxInternalCalls or timeoutMs is set. Idle time between checks does not count. An iteration stops at its first error.`,
        frozen:
          "Evaluate a Scheme program once. `description` is optional and must be one line when set — the transcript shows it in place of the program, which is only visible on expand. Omit it and the program is the collapsed row. Use scheme_watch only for requested recurring monitoring. Live bound-tool catalog is projected at list time.",
        validate: undefined,
        watchProjected: `Monitor over time by re-evaluating a sandboxed Scheme program at the required period. \`description\` is optional and must be one line when set — the transcript shows it in place of the program, which is only visible on expand. Omit it and the program is the collapsed row. Use only when the user requests ongoing monitoring or repeated checks, for example watching GitHub comments for new activity. Use scheme_repl for one-shot work, including agent requests; background execution alone does not require a watcher. The harness schedules checks without a new model turn per check, saving context and tokens compared with a conversational loop.
All scheme_repl symbols, tools, calling conventions, and worker APIs are available here; see scheme_repl for their shared definitions and live catalog. Watcher-only additions:
(meta-reactivity/done-condition pred [result]) ends the watcher when pred is true. Each iteration must call it on a reachable path; quoted forms, unapplied lambdas, and unreachable branches do not count. Use a predicate matching the requested stopping condition, not constant true just to satisfy validation. For ongoing monitoring until cancelled, use #f.
(meta-reactivity/added|removed|changed list [:identity fn]) tracks differences across iterations.
Use the shared (self/notify message) to send an update without ending the watcher. For “wake me when something new appears,” notify on the event and then set the done condition true. For “keep notifying me about new comments,” notify on new events and keep the done condition false. Use background: true for notifications to arrive in the conversation while monitoring continues; inside a worker request, updates attach to that request.
Each iteration runs in a fresh Scheme scope; reactivity state persists across iterations. There is no inner-call or time limit unless maxInternalCalls or timeoutMs is set. Idle time between checks does not count. An iteration stops at its first error.`,
      },
      live: {
        positional: true,
        grep: true,
        kwargs: true,
        grepKwargs: true,
        mcp: true,
        span: true,
        filesKind: false,
        github: false,
        named: true,
        swarm: true,
        programOnce: true,
        unwrap: true,
        smallFace: true,
        largeFace: true,
        hint: true,
        wireMcp: true,
        handwrittenList: false,
        jargon: false,
        relevantNames: ["scheme_repl"],
        validateHidden: false,
      },
      models: {
        ref: { connection: "openrouter", model: "anthropic/claude" },
        bad: undefined,
        pin: "",
        ghost: "unknown model nope on openai",
        inventory: true,
      },
    });
  });
});
