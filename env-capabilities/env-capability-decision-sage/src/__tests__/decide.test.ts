import { execState, toJS } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { sageDecideCapability, type DecideComplete, type DecideRequest } from "../capability.js";

const KEY = "lv_live_test";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function run(source: string, config: { apiKey?: string; fetch?: typeof fetch; complete?: DecideComplete } = {}) {
  const state = await execState(source, { capabilities: [sageDecideCapability], config });
  const value = state.values.at(0);
  if (value === undefined) throw new Error("no result");
  return toJS(value);
}

describe("sage decide", () => {
  it("choose reads Sage and does not call complete", async () => {
    let completeCalls = 0;
    let sent: unknown;
    const result = await run('(decide/choose "which fruit" (list (list "apple" "red") (list "pear" "green")))', {
      apiKey: KEY,
      fetch: (_input, init) => {
        sent = JSON.parse(String(init?.body));
        return Promise.resolve(
          json({
            id: "choose",
            kind: "choice",
            meta: {},
            result: {
              chosen: "apple",
              probability: 0.8,
              probabilities: [
                { option: "apple", probability: 0.8 },
                { option: "pear", probability: 0.2 },
              ],
            },
          }),
        );
      },
      complete: async () => {
        completeCalls += 1;
        return { value: "pear" };
      },
    });
    expect({ result, completeCalls, sent }).toEqual({
      result: "apple",
      completeCalls: 0,
      sent: {
        content: "which fruit",
        question: {
          kind: "choice",
          id: "choose",
          instructions: "which fruit",
          options: [
            { option: "apple", description: "red" },
            { option: "pear", description: "green" },
          ],
        },
      },
    });
  });

  it("a thrown Sage falls back to complete", async () => {
    const requests: DecideRequest[] = [];
    const result = await run('(decide/yesno "safe?")', {
      apiKey: KEY,
      fetch: () => Promise.reject(new Error("sage down")),
      complete: async (request) => {
        requests.push(request);
        return { value: "yes" };
      },
    });
    expect({ result, requests }).toEqual({ result: "yes", requests: [{ kind: "yesno", instructions: "safe?" }] });
  });

  it("an aborted Sage call does not fall back", async () => {
    const abort = new Error("stopped");
    abort.name = "AbortError";
    let completeCalls = 0;
    let message = "resolved";
    try {
      await run('(decide/yesno "safe?")', {
        apiKey: KEY,
        fetch: () => Promise.reject(abort),
        complete: async () => {
          completeCalls += 1;
          return { value: "yes" };
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect({ message, completeCalls }).toEqual({ message: "Request was aborted.", completeCalls: 0 });
  });

  it("gauge accepts an in-range value and rejects a bad width", async () => {
    const complete: DecideComplete = async () => ({ value: 1 });
    async function message(source: string): Promise<string> {
      try {
        await run(source, { complete });
        return "resolved";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    expect({
      value: await run('(decide/gauge "n" 1 3)', {
        apiKey: KEY,
        fetch: () =>
          Promise.resolve(
            json({
              id: "gauge",
              kind: "scale",
              meta: {},
              result: {
                expectation: 2,
                confidence: 0.5,
                probabilities: [
                  { level: 1, probability: 0.2 },
                  { level: 2, probability: 0.6 },
                  { level: 3, probability: 0.2 },
                ],
              },
            }),
          ),
      }),
      one: await message('(decide/gauge "n" 4 4)'),
      wide: await message('(decide/gauge "n" 0 26)'),
    }).toEqual({
      value: 2,
      one: "gauge must produce 2..26 levels",
      wide: "gauge must produce 2..26 levels",
    });
  });

  it("sort rejects a list that drops an id", async () => {
    await expect(
      run('(decide/sort "rank" (list (list "a" "one") (list "b" "two")))', {
        complete: async () => ({ value: ["a"] }),
      }),
    ).rejects.toThrow("sort is not a permutation");
  });
});
