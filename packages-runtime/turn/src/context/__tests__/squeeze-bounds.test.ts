import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { ProgrammaticJob, SessionPlexus, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { compactToolLine, SQUEEZE_COMPACT_CHARS, squeezeObservation } from "../squeeze.js";

beforeEach(() => resetLocalIDs());

describe("programmatic results are bounded", () => {
  it("caps a huge scheme_repl result on the squeeze line and points at context_recall", () => {
    const huge = "z".repeat(SQUEEZE_COMPACT_CHARS * 20);
    const job = new ProgrammaticJob({
      toolCallId: "prog-1",
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, text: huge }),
    });
    const plexus = SessionPlexus.create("squeeze-programmatic");
    onTestFinished(() => plexus.destroy());
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`p`, queue: [] });
    turn.pushChild(job);
    plexus.root.head = turn;
    const line = compactToolLine(job);
    expect(line.length).toBeLessThan(SQUEEZE_COMPACT_CHARS + 300);
    expect(line).toContain(`;;full response: context_recall {"ref":"job:${job.uuid.slice(0, 8)}"}`);
  });
});

describe("reduced observations point at the graph, not at disk", () => {
  const over = "q".repeat(SQUEEZE_COMPACT_CHARS + 10);

  it("writes nothing under the temp directory", () => {
    const out = squeezeObservation({
      to: "compact",
      payload: over,
      persistable: true,
      recallRef: "job:abcd1234",
      name: "x",
    });
    expect(out).toBe(
      `;;full response: context_recall {"ref":"job:abcd1234"}\n${over.slice(0, SQUEEZE_COMPACT_CHARS)}…(+10 chars)`,
    );
    expect(existsSync(path.join(tmpdir(), "harness-squeeze-0"))).toBe(false);
  });

  it("without a ref the result is only truncated", () => {
    const out = squeezeObservation({ to: "compact", payload: over, persistable: true, name: "x" });
    expect(out.startsWith(";;full response")).toBe(false);
    expect(out).toContain("…(+10 chars)");
  });

  it("a regeneratable result carries no pointer: re-invoking is the address", () => {
    const out = squeezeObservation({
      to: "compact",
      payload: over,
      persistable: false,
      recallRef: "job:abcd1234",
      name: "x",
    });
    expect(out.startsWith(";;full response")).toBe(false);
  });
});
