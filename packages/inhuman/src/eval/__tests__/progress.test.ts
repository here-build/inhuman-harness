import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallNotification,
  CompletionExpectation,
  CompletionJob,
  ProgrammaticJob,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { visitEvalProgress } from "../progress.js";

function collect(program: ProgrammaticJob, seen = new Set<string>()): string[] {
  const lines: string[] = [];
  visitEvalProgress(program, (id, line) => {
    if (seen.has(id)) return;
    seen.add(id);
    lines.push(line);
  });
  return lines;
}

describe("eval progress", () => {
  it("prints notifies and PEW live/done; sealed catch-up skips live; responseText stays off", () => {
    const seen = new Set<string>();
    const program = new ProgrammaticJob({ toolCallId: "p", argsJson: '{"expr":"1"}' });
    program.notifications.push(new AgentCallNotification({ message: "analyzing" }));
    const live = new CompletionExpectation({
      connectionId: "c1",
      model: "test-model",
      promptText: prompt.user`SECRET IR should not print`,
    });
    program.children.push(new CompletionJob({ expectation: live }));
    const mid = collect(program, seen);

    live.succeed("settled", "", "null", { result: { text: JSON.stringify({ analysis: "SECRET IR" }) } });
    const after = collect(program, seen);

    const sealed = new CompletionExpectation({
      connectionId: "c1",
      model: "test-model",
      promptText: prompt.user`also secret`,
    });
    sealed.fail("crash", "model unavailable", "null");
    program.children.push(new CompletionJob({ expectation: sealed }));
    program.notifications.push(new AgentCallNotification({ message: "  lowering  " }));
    const caught = collect(program, seen);

    expect({
      mid,
      after,
      caught,
      leaked: [...mid, ...after, ...caught].some((line) => line.includes("SECRET")),
    }).toEqual({
      mid: ["  analyzing", "  test-model  live"],
      after: ["  test-model  done"],
      caught: ["  lowering", "  test-model  model unavailable"],
      leaked: false,
    });
  });
});
