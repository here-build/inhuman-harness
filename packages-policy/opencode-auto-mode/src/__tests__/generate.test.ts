import { describe, expect, it } from "vitest";

import { register, type GenerateText, type PermissionEvaluation, type PermissionHost } from "../index.js";

async function judged(experimental: PermissionHost["experimental"], options?: unknown): Promise<string> {
  const event: PermissionEvaluation = { action: "shell", resources: ["rm -rf /tmp/x"], effect: "ask" };
  const ctx: PermissionHost = {
    ...(options === undefined ? {} : { options }),
    ...(experimental === undefined ? {} : { experimental }),
    permission: {
      hook: async (_name, callback) => {
        await callback(event);
      },
    },
  };
  await register(ctx);
  return event.effect;
}

function generating(reply: () => Promise<{ text?: string; data?: { text?: string } }>, prompts: unknown[] = []) {
  const text: GenerateText = async (input) => {
    prompts.push(input);
    return reply();
  };
  return { generate: { text } };
}

describe("judge on OpenCode's own model", () => {
  it("allow vote allows and the prompt carries the decide instructions", async () => {
    const prompts: { prompt: string }[] = [];
    const effect = await judged(generating(async () => ({ text: '{"value":"allow"}' }), prompts));
    expect(effect).toBe("allow");
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]?.prompt).toContain("You are a decision function");
    expect(prompts[0]?.prompt).toContain("rm -rf /tmp/x");
  });

  it("accepts a fenced, data-wrapped answer", async () => {
    const effect = await judged(generating(async () => ({ data: { text: '```json\n{"value":"allow"}\n```' } })));
    expect(effect).toBe("allow");
  });

  it("deny vote denies", async () => {
    expect(await judged(generating(async () => ({ text: '{"value":"deny"}' })))).toBe("deny");
  });

  it("a throw denies", async () => {
    const effect = await judged(
      generating(async () => {
        throw new Error("model down");
      }),
    );
    expect(effect).toBe("deny");
  });

  it("an absent generate denies", async () => {
    expect(await judged(undefined)).toBe("deny");
    expect(await judged({})).toBe("deny");
  });

  it("passes the model named in the options", async () => {
    const prompts: { model?: unknown }[] = [];
    await judged(
      generating(async () => ({ text: '{"value":"deny"}' }), prompts),
      {
        model: { id: "m", providerID: "p" },
      },
    );
    expect(prompts[0]?.model).toEqual({ id: "m", providerID: "p" });
  });
});
