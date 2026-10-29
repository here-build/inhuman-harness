import { execState, toJS } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { jevDecideCapability, type DecideComplete } from "../capability.js";

const chooseFruit = '(decide/choose "which fruit" (list (list "apple" "red") (list "pear" "green")))';

function clientThat(read: () => Promise<{ answers: { vote: { choice?: string; noul?: number } } }>) {
  return class {
    async systemOne() {
      return read();
    }
  };
}

async function run(source: string, config: { complete?: DecideComplete; Client?: ReturnType<typeof clientThat> }) {
  const state = await execState(source, {
    capabilities: [jevDecideCapability],
    config,
  });
  const value = state.values.at(0);
  if (value === undefined) throw new Error("no result");
  return toJS(value);
}

describe("jev decide", () => {
  it("choose reads the client choice and does not call complete", async () => {
    let completeCalls = 0;
    const complete: DecideComplete = async () => {
      completeCalls += 1;
      return { value: "pear" };
    };
    const result = await run(chooseFruit, {
      Client: clientThat(async () => ({ answers: { vote: { choice: "apple" } } })),
      complete,
    });
    expect({ result, completeCalls }).toEqual({ result: "apple", completeCalls: 0 });
  });

  it("a thrown client falls back to complete", async () => {
    const result = await run('(decide/yesno "safe?")', {
      Client: clientThat(async () => {
        throw new Error("jev down");
      }),
      complete: async () => ({ value: "yes" }),
    });
    expect(result).toBe("yes");
  });

  it("a thrown client with no complete rejects", async () => {
    await expect(
      run('(decide/yesno "safe?")', {
        Client: clientThat(async () => {
          throw new Error("jev down");
        }),
      }),
    ).rejects.toThrow("no structured complete");
  });
});
