import { exec } from "@here.build/arrival";
import { arrivalLoaderCapability, loaderFromResolver } from "@here.build/arrival-modules";
import { dotpromptCapability, ParsedPrompt } from "@inhuman.tools/env-capability-dotprompt";
import { ProgrammaticJob } from "@inhuman.tools/harness-model";
import dedent from "dedent";
import { describe, expect, it } from "vitest";

import { promptProgramCapability } from "../run-program.js";

const HI = dedent`
  ---
  model: test-model
  ---
  {{role "user"}}
  Hello {{evidence}}
`;

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("promptCapability require", () => {
  it('(require "x.prompt") is a scheme procedure', async () => {
    const results = await exec(`(define greet (require "hi.prompt")) (procedure? greet)`, {
      capabilities: [promptProgramCapability],
      config: { loader: files({ "hi.prompt": HI }), job: new ProgrammaticJob({ toolCallId: "j", argsJson: "{}" }) },
    });
    expect(results.at(-1)).toBe(true);
  });

  it("a run without ext/prompt cannot resolve .prompt", async () => {
    await expect(
      exec(`(require "unseen.prompt")`, {
        capabilities: [arrivalLoaderCapability],
        config: { loader: files({ "unseen.prompt": HI }) },
      }),
    ).rejects.toThrow(/no-resolver|no resolver/i);
  });
});

it("keeps ParsedPrompt fields readable through the object membrane", async () => {
  const results = await exec(
    `
    (define spec (dotprompt/parse ${JSON.stringify(HI)} "hi.prompt"))
    spec
    (:faceName spec)
  `,
    { capabilities: [dotpromptCapability] },
  );
  expect(results[1]).toBeInstanceOf(ParsedPrompt);
  expect(results[2]).toBe("hi");
});

it("rejects a non-spec at dotprompt/run", async () => {
  await expect(
    exec(`(dotprompt/run (dict :mode "chat") '())`, {
      capabilities: [promptProgramCapability],
      config: { job: new ProgrammaticJob({ toolCallId: "j", argsJson: "{}" }) },
    }),
  ).rejects.toThrow(/arguments rejected/);
});
