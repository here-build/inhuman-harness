/**
 * Isolated host for `.prompt`. `dotprompt/run` performs one completion
 * on the configured job (compact, classifier).
 */
import { EnvCapability } from "@here.build/arrival";
import { arrivalLoaderCapability } from "@here.build/arrival-modules";
import { dotpromptCapability, ParsedPrompt } from "@inhuman.tools/env-capability-dotprompt";
import { CompletionExpectation, CompletionJob, ProgrammaticJob, PromptMessage } from "@inhuman.tools/harness-model";
import { Job } from "@inhuman.tools/plexus-expectations";
import invariant from "tiny-invariant";
import { z } from "zod";

import { promptPrelude, renderPrompt } from "./dotprompt.js";

export const promptIsolatedCapability = EnvCapability.define("ext/prompt/isolated", {
  deps: [dotpromptCapability, arrivalLoaderCapability],
  configuration: {
    job: z.instanceof(Job).refine((job) => !(job instanceof ProgrammaticJob), {
      error: "dotprompt/run: a program uses promptProgramCapability",
    }),
    connectionId: z
      .string({ error: "dotprompt/run: connectionId is required" })
      .refine((value) => value !== "", { error: "dotprompt/run: connectionId is required" }),
    model: z.string().optional(),
    /** Session/judge model. `model` is reserved by some exec hosts. */
    completionModel: z.string().optional(),
  },
  symbols: (symbol, sz) => ({
    "dotprompt/run": symbol.rosetta`dotprompt/run: completes the rendered prompt in isolation`(
      {
        input: [sz.box.pipe(z.instanceof(ParsedPrompt)), sz.list(sz.dynamic)],
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["job"],
      },
      async function (spec, args) {
        const bundle = renderPrompt(spec, args);
        // Render overlays :meta, then the file model. The host model is appended here.
        const model =
          [bundle.model, this.configuration.completionModel, this.configuration.model].find(
            (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
          ) ?? null;
        invariant(model != null, "dotprompt/run: model is required");
        // The session orchestrator drives the CompletionJob. Await reads its result.
        return await this.configuration.job.registerJob(
          new CompletionJob({
            expectation: new CompletionExpectation({
              connectionId: this.configuration.connectionId,
              model,
              responseSchema: bundle.responseSchema,
              completionMode: "isolated",
              promptMessages: bundle.messages.map(([role, content]) => new PromptMessage({ role, content })),
              reasoningEffort: bundle.reasoningEffort,
            }),
            turnTail: this.configuration.job,
          }),
        );
      },
    ),
  }),
  prelude: promptPrelude,
});
