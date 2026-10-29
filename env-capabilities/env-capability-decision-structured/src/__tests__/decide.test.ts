import { execState, toJS } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { structuredOutputDecideCapability, type DecideComplete, type DecideRequest } from "../capability.js";

async function run(source: string, complete?: DecideComplete, document?: string) {
  const state = await execState(source, {
    capabilities: [structuredOutputDecideCapability],
    config: { ...(complete === undefined ? {} : { complete }), ...(document === undefined ? {} : { document }) },
  });
  const value = state.values.at(0);
  if (value === undefined) throw new Error("no result");
  return toJS(value);
}

function recording(answer: unknown): { complete: DecideComplete; requests: DecideRequest[] } {
  const requests: DecideRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      return answer;
    },
  };
}

describe("structured decide", () => {
  it("choose returns the option and the request contains the descriptions", async () => {
    const { complete, requests } = recording({ value: "apple" });
    const result = await run(
      '(decide/choose "which fruit" (list (list "apple" "red") (list "pear" "green")))',
      complete,
    );
    expect({ result, requests }).toEqual({
      result: "apple",
      requests: [
        {
          kind: "choose",
          instructions: "which fruit",
          options: [
            { option: "apple", description: "red" },
            { option: "pear", description: "green" },
          ],
        },
      ],
    });
  });

  it("null abstains and yes returns yes", async () => {
    const none = async () => ({ value: null });
    expect({
      choose: await run('(decide/choose "which" (list (list "apple" "red")))', none),
      yesno: await run('(decide/yesno "safe?")', none),
      yes: await run('(decide/yesno "safe?")', async () => ({ value: "yes" })),
    }).toEqual({ choose: false, yesno: false, yes: "yes" });
  });

  it("choose of an unknown option throws", async () => {
    await expect(
      run('(decide/choose "which" (list (list "apple" "red")))', async () => ({ value: "pear" })),
    ).rejects.toThrow("choice outside options");
  });

  it("missing complete throws no structured complete", async () => {
    await expect(run('(decide/yesno "safe?")')).rejects.toThrow("no structured complete");
  });
  it("the configured document reaches complete", async () => {
    const { complete, requests } = recording({ value: "yes" });
    await run('(decide/yesno "safe?")', complete, "rm -rf build");
    expect(requests).toEqual([{ kind: "yesno", instructions: "safe?", document: "rm -rf build" }]);
  });
});
