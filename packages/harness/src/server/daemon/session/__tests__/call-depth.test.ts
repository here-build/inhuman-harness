import { AgentCallJob, AskAgentSpec, BotCallJob, FailureOutcome, SessionRoot } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { executeAgentCall, executeBotCall, type AgentRuntimeHost } from "../agent-runtime.js";

function hostAt(opts: { depth?: number; botDepth?: number; maxDepth?: number; maxBotDepth?: number }) {
  const caller = new SessionRoot({ sessionId: "caller", path: "/tmp" });
  caller.agent.spec = new AskAgentSpec({ name: "", depth: opts.depth ?? 0, botDepth: opts.botDepth ?? 0 });
  const root = { maxDepth: opts.maxDepth ?? 0, maxBotDepth: opts.maxBotDepth ?? 0 };
  const host = {
    caller,
    kernel: {
      plexus: { root },
      // Anything past the depth check is out of scope here; a bot call stops at the catalog.
      catalog: { catalogEntry: () => undefined, recipe: () => undefined },
    },
    project: {},
  } as unknown as AgentRuntimeHost;
  return { host, root };
}

const failure = (job: AgentCallJob | BotCallJob) => (job.outcome instanceof FailureOutcome ? job.outcome : null);

describe("agent depth", () => {
  it("refuses a spawn past maxDepth, with the reason as the call's receipt", async () => {
    const { host } = hostAt({ depth: 2, maxDepth: 2 });
    const job = new AgentCallJob({ toolCallId: "c", name: "agent__ask", argsJson: '{"speech":"x"}' });
    await executeAgentCall(job, host);
    expect(failure(job)).toMatchObject({ code: "depth_limit", message: expect.stringContaining("maxDepth") });
    expect({ depth: job.depth, limit: job.depthLimit, completed: job.completed }).toEqual({
      depth: 3,
      limit: 2,
      completed: true,
    });
  });

  it("is unlimited by default", async () => {
    const { host } = hostAt({ depth: 50 });
    const job = new AgentCallJob({ toolCallId: "c", name: "agent__ask", argsJson: '{"speech":"x","spec":"nope"}' });
    await executeAgentCall(job, host).catch(() => undefined);
    expect({ depth: job.depth, limit: job.depthLimit }).toEqual({ depth: 51, limit: 0 });
    expect(failure(job)?.code).not.toBe("depth_limit");
  });

  it("allows a spawn at exactly the cap", async () => {
    const { host } = hostAt({ depth: 1, maxDepth: 2 });
    const job = new AgentCallJob({ toolCallId: "c", name: "agent__ask", argsJson: '{"speech":"x","spec":"nope"}' });
    await executeAgentCall(job, host).catch(() => undefined);
    expect(failure(job)?.code).not.toBe("depth_limit");
  });

  it("keeps the cap recorded when the call started, however the setting moves", async () => {
    const { host, root } = hostAt({ depth: 1, maxDepth: 5 });
    const job = new AgentCallJob({ toolCallId: "c", name: "agent__ask", argsJson: '{"speech":"x","spec":"nope"}' });
    await executeAgentCall(job, host).catch(() => undefined);
    root.maxDepth = 1;
    const again = job.depthLimit;
    await executeAgentCall(job, host).catch(() => undefined);
    expect({ again, now: job.depthLimit, code: failure(job)?.code }).toMatchObject({ again: 5, now: 5 });
    expect(failure(job)?.code).not.toBe("depth_limit");
  });
});

describe("bot depth", () => {
  it("counts bot hops apart from agent spawns", async () => {
    // Deep in agent spawns but only one bot hop: maxBotDepth is the cap that matters.
    const { host } = hostAt({ depth: 9, botDepth: 0, maxDepth: 1, maxBotDepth: 1 });
    const job = new BotCallJob({ toolCallId: "b", name: "agent__ask", argsJson: "{}", botName: "x" });
    await executeBotCall(job, host);
    expect({ depth: job.depth, limit: job.depthLimit }).toEqual({ depth: 1, limit: 1 });
    expect(failure(job)?.code).not.toBe("depth_limit");
  });

  it("refuses a bot hop past maxBotDepth even when agent depth is unlimited", async () => {
    const { host } = hostAt({ depth: 0, botDepth: 1, maxBotDepth: 1 });
    const job = new BotCallJob({ toolCallId: "b", name: "agent__ask", argsJson: "{}", botName: "x" });
    await executeBotCall(job, host);
    expect(failure(job)).toMatchObject({ code: "depth_limit", message: expect.stringContaining("maxBotDepth") });
  });
});
