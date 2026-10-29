/**
 * Render both prompt hosts call, and the prelude they install.
 * `dotprompt/parse` is `dotpromptCapability`.
 */
import { type SchemeValue, toJS } from "@here.build/arrival";
import { compileTemplate, runCompiledTemplate } from "@here.build/arrival-modules/handlebars";
import { isPlainRecord, type ParsedPrompt, reasoningEffortSchema } from "@inhuman.tools/env-capability-dotprompt";
import { type PromptMessageRole } from "@inhuman.tools/harness-model";
import invariant from "tiny-invariant";
import { z } from "zod";

import { RenderedPrompt } from "./bundle.js";

const promptMeta = z.object({
  model: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
});

export function renderPrompt(spec: ParsedPrompt, args: readonly unknown[]): RenderedPrompt {
  let pairs = args;
  let positional: unknown;
  if (pairs.length > 0) {
    const head = String(pairs[0]);
    if (!(head.startsWith(":") || head.startsWith("':"))) {
      positional = pairs[0];
      pairs = pairs.slice(1);
    }
  }
  const folded: Record<string, unknown> = {};
  if (pairs.length > 0) {
    invariant(pairs.length % 2 === 0, "kwargs: needs an even number of trailing args (alternating :key value pairs)");
    for (let i = 0; i < pairs.length; i += 2) {
      folded[String(pairs[i]).replace(/^'?:/, "")] = toJS(pairs[i + 1] as SchemeValue);
    }
  }
  let inputs: Record<string, unknown> | undefined;
  let meta: z.infer<typeof promptMeta> | undefined;
  if (positional !== undefined) {
    const value = toJS(positional as SchemeValue);
    if (isPlainRecord(value) && Object.keys(folded).length === 0) {
      const metaRaw = isPlainRecord(value.meta) ? value.meta : {};
      const { meta: _meta, key: _key, ...rest } = value;
      inputs = rest;
      meta = promptMeta.parse(metaRaw);
    } else if (folded.evidence === undefined) {
      folded.evidence = value;
    }
  }
  if (inputs === undefined || meta === undefined) {
    const metaRaw = isPlainRecord(folded.meta) ? folded.meta : {};
    const { meta: _metaSlot, key: _keySlot, ...rest } = folded;
    inputs = rest;
    meta = promptMeta.parse(metaRaw);
  }
  const rendered = spec.sections.map((section): [PromptMessageRole, string] => [
    section.role,
    runCompiledTemplate(compileTemplate(section.source), [inputs]),
  ]);
  const model =
    [meta.model, spec.model].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
    ) ?? null;
  return new RenderedPrompt(
    model,
    meta.reasoningEffort ?? spec.reasoningEffort,
    spec.responseSchema,
    spec.faceName,
    spec.tools,
    spec.mode === "instruct" ? [["user", rendered.map(([, content]) => content).join("\n\n")]] : rendered,
  );
}

/** Both prompt hosts install this prelude. Require parses once and closes over the spec. */
export const promptPrelude = `(define (ext/prompt/resolve contents)
  (let ((spec (dotprompt/parse (if (bytevector? contents) (utf8->string contents) contents)
                               "anonymous.prompt")))
    ;; apply would run dotprompt/run under the lists capability's context.
    (lambda args
      (dotprompt/run spec args))))
(require/register-extension ".prompt" ext/prompt/resolve)`;
