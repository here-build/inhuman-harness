/**
 * Program host for `.prompt`. `dotprompt/run` parents an omitted-spec
 * AgentCallJob on the ProgrammaticJob and waits for the worker.
 */
import { EnvCapability } from "@here.build/arrival";
import { arrivalLoaderCapability } from "@here.build/arrival-modules";
import { dotpromptCapability, ParsedPrompt } from "@inhuman.tools/env-capability-dotprompt";
import {
  AgentCallJob,
  claimCrossing,
  crossingPending,
  crossingWindow,
  isReplaying,
  ProgrammaticJob,
  PromptMessage,
  takeCrossing,
} from "@inhuman.tools/harness-model";
import { runInAction, when } from "mobx";
import { z } from "zod";

import { promptPrelude, renderPrompt } from "./dotprompt.js";

const AGENT_ASK = "agent__ask";

export const promptProgramCapability = EnvCapability.define("ext/prompt/program", {
  deps: [dotpromptCapability, arrivalLoaderCapability],
  configuration: {
    job: z.instanceof(ProgrammaticJob),
    readonly: z.boolean().default(false),
  },
  symbols: (symbol, sz) => ({
    "dotprompt/run": symbol.rosetta`dotprompt/run: parents an omitted-spec AgentCallJob on the program and waits`(
      {
        input: [sz.box.pipe(z.instanceof(ParsedPrompt)), sz.list(sz.dynamic)],
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["job"],
      },
      async function (spec, args) {
        const bundle = renderPrompt(spec, args);
        const job = this.configuration.job;
        const emission = this.runCtx.emission;
        const path = job.trackMatch && emission != null ? claimCrossing(emission, crossingWindow(this)) : "";
        if (path !== "" && emission != null) {
          let existing = takeCrossing(job, emission, path);
          if (existing == null && isReplaying(emission)) {
            if (!job.completed && !job.cancelled) {
              const joined = when(() => job.completed || job.cancelled || crossingPending(job, emission, path));
              try {
                await joined;
              } finally {
                joined.cancel();
              }
            }
            existing = takeCrossing(job, emission, path);
            if (existing == null) throw new Error("replay: no recorded dotprompt/run");
          }
          if (existing != null) return await existing;
        }
        const minted = new AgentCallJob({
          toolCallId: `${job.toolCallId}:prompt:${job.children.length + 1}`,
          name: AGENT_ASK,
          argsJson: "{}",
          voidLegal: false,
          readonly: this.configuration.readonly === true,
          responseSchema: bundle.responseSchema,
          promptMessages: bundle.messages.map(([role, content]) => new PromptMessage({ role, content })),
          faceName: bundle.faceName.trim(),
          tools: bundle.tools ?? [],
          inheritCallerTools: bundle.tools === null,
          reasoningEffort: bundle.reasoningEffort,
        });
        if (path !== "") runInAction(() => (minted.track = path));
        return await job.registerJob(minted);
      },
    ),
  }),
  prelude: promptPrelude,
});
