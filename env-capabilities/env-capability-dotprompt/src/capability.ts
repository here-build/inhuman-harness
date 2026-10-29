/**
 * `dotprompt/parse`. Each host depends on this capability and defines its own `dotprompt/run`.
 * The loader that serves `.prompt` files is the host's dependency, not this one's.
 */
import { EnvCapability } from "@here.build/arrival";
import { picoschema } from "dotprompt";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { isPlainRecord, ParsedPrompt, reasoningEffortSchema } from "./parse.js";

const roleSection =
  /\{\{\s*role\s+["'](?<role>[a-zA-Z]+)["']\s*\}\}(?<source>[\s\S]*?)(?=\{\{\s*role\s+["'][a-zA-Z]+["']\s*\}\}|$)/g;

const frontmatterFence = /^---\n([\s\S]*?)\n---\n?/;

const withFrontmatter = z
  .string()
  .regex(frontmatterFence)
  .transform((contents) => {
    const hit = contents.match(frontmatterFence);
    if (hit === null) return { fm: {}, body: contents };
    return { fm: parseYaml(hit[1]) ?? {}, body: contents.slice(hit[0].length) };
  });

const withoutFrontmatter = z.string().transform((contents) => ({ fm: {}, body: contents }));

// The fence arm is first. A matched fence that fails the frontmatter map is not read as a bare file.
const splitFrontmatter = z.union([withFrontmatter, withoutFrontmatter]);

// Role split is over the author source, before call-site interpolation: a rendered hole cannot forge a turn.
// Match arrays are not objects, so the string arm lifts captures before the section schema sees them.
const promptSections = z
  .string()
  .transform((text) => ({
    text,
    marks: [...text.matchAll(roleSection)].map((mark) => {
      const groups = isPlainRecord(mark.groups) ? mark.groups : {};
      return { index: mark.index, role: groups.role, source: groups.source };
    }),
  }))
  .pipe(
    z
      .object({
        text: z.string(),
        marks: z
          .array(
            z.object({
              index: z.number(),
              role: z
                .string()
                .toLowerCase()
                .pipe(
                  z.enum(["system", "user", "assistant"], {
                    error: (issue) => `.prompt: unknown role "${String(issue.input)}" — use system, user, or assistant`,
                  }),
                ),
              source: z.string().trim(),
            }),
          )
          .min(1, { error: `.prompt: no {{role "..."}} markers — a chat template needs at least one` }),
      })
      .superRefine(({ text, marks }, ctx) => {
        const first = marks.at(0);
        if (first !== undefined && text.slice(0, first.index).trim() !== "") {
          ctx.addIssue({
            code: "custom",
            message: `.prompt: text before the first {{role}} marker — a chat template must open with {{role "system|user|assistant"}}`,
          });
        }
      })
      .transform(({ marks }) => marks.map(({ role, source }) => ({ role, source }))),
  );

export const dotpromptCapability = EnvCapability.define("dotprompt", {
  symbols: (symbol, sz) => ({
    "dotprompt/parse": symbol.rosetta`dotprompt/parse: parses a .prompt file into a ParsedPrompt`(
      { input: [sz.string, sz.string], output: [sz.box.pipe(z.instanceof(ParsedPrompt))] },
      async function (contents, path) {
        // Every call re-parses. A source cache is the first place to look if prompt require shows up in a profile.
        const stem = (path.replaceAll("\\", "/").split("/").pop() ?? path).replace(/\.prompt$/i, "");
        const faceDefault = stem === "" || stem === "anonymous" ? "prompt" : stem;
        const frontmatter = z.object(
          {
            model: z
              .string({ error: ".prompt: frontmatter `model:` must be a model name string or omitted" })
              .nullable()
              .default(null)
              .overwrite((value) => (value === "" ? null : value)),
            agent: z.null({ error: `.prompt: "${path}" frontmatter \`agent:\` is not supported` }).optional(),
            mcp: z.null({ error: `.prompt: "${path}" frontmatter \`mcp:\` is not supported` }).optional(),
            fallbackModels: z
              .null({ error: `.prompt: "${path}" frontmatter \`fallbackModels:\` is not supported` })
              .optional(),
            name: z
              .string({ error: `.prompt: "${path}" frontmatter \`name:\` must be a string` })
              .trim()
              .default(faceDefault)
              .overwrite((value) => (value === "" ? faceDefault : value)),
            // `.default` fills `undefined` only. An empty YAML `mode:` is null.
            mode: z.preprocess(
              (value: unknown) => value ?? undefined,
              z
                .enum(["instruct", "chat"], {
                  error: (issue) =>
                    `.prompt: "${path}" frontmatter \`mode:\` must be "instruct" or "chat", got ${JSON.stringify(issue.input)}`,
                })
                .default("chat"),
            ),
            output: z
              .unknown()
              .optional()
              .transform(async (output) => picoschema(output)),
            reasoningEffort: reasoningEffortSchema.nullable().default(null),
            tools: z
              .array(
                z
                  .string({
                    error: (issue) =>
                      `.prompt: "${path}" tools[${String(issue.path?.at(-1))}] must be a non-empty string`,
                  })
                  .trim()
                  .min(1, {
                    error: (issue) =>
                      `.prompt: "${path}" tools[${String(issue.path?.at(-1))}] must be a non-empty string`,
                  }),
                {
                  error: `.prompt: "${path}" frontmatter \`tools:\` must be a list of tool names`,
                },
              )
              .nullable()
              .default(null),
          },
          { error: ".prompt: frontmatter must be a YAML map" },
        );
        return splitFrontmatter
          .pipe(z.object({ fm: frontmatter, body: promptSections }))
          .transform(
            ({ fm, body }) =>
              new ParsedPrompt(fm.mode, fm.model, fm.reasoningEffort, fm.output, fm.name, fm.tools, body),
          )
          .parseAsync(contents);
      },
    ),
  }),
});
