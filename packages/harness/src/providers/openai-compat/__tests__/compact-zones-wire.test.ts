/** viewWire squeezes the compact band and leaves keep and later cells full. */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  responseCall,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { describe, expect, it, onTestFinished } from "vitest";

import { chatContentText, viewWire, type ChatMessage } from "../actor.js";

function completion(promptText: string, responseText = ""): CompletionExpectation {
  const node = new CompletionExpectation({
    connectionId: "c1",
    promptText: prompt.user`${promptText}`,
  });
  node.responseText = responseText;
  return node;
}

function tool(
  id: string,
  name: string,
  extra: { readonly outcome: string; readonly regenerateable?: boolean },
): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name,
    argsJson: "{}",
    outcomeJson: JSON.stringify({ ok: true, text: extra.outcome }),
    completed: true,
    ...(extra.regenerateable === true ? { regenerateable: true } : {}),
  });
}

describe("compact zones on the wire", () => {
  it("viewWire squeezes the band and leaves keep and later cells full", () => {
    resetLocalIDs();
    const fold = completion("fold-user", "fold-asst");
    const foldTool = tool("fold_tool", "shell", { outcome: "FOLD_SECRET" });
    fold.setResponseCalls([responseCall("fold_tool", "shell")]);
    const squeeze = completion("sq-user", "sq-asst");
    const regen = tool("regen", "read_file", { outcome: "SECRET_READ", regenerateable: true });
    const stored = tool("stored", "echo", { outcome: "STORED" });
    const blank = tool("blank", "grep", { outcome: "" });
    squeeze.setResponseCalls([
      responseCall("regen", "read_file"),
      responseCall("stored", "echo"),
      responseCall("blank", "grep"),
    ]);
    const keep = completion("keep-user", "keep-asst");
    const keepTool = tool("keep_tool", "edit_file", { outcome: "KEEP_FULL" });
    keep.setResponseCalls([responseCall("keep_tool", "edit_file")]);
    keep.messages = [fold, foldTool, squeeze, regen, stored, blank];
    const cutoff = new CompactJob({ reason: "overflow", standIn: "CARD", completed: true, keepTurns: 1 });
    const after = completion("after-user", "after-asst");
    const afterTool = tool("after_tool", "grep", { outcome: "AFTER_FULL" });
    after.setResponseCalls([responseCall("after_tool", "grep")]);
    const tip = completion("tip-user");
    const plexus = SessionPlexus.create("compact-zones-wire");
    onTestFinished(() => plexus.destroy());
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`q`,
      queue: [],
    });
    for (const cell of [fold, foldTool, squeeze, regen, stored, blank, keep, keepTool, cutoff, after, afterTool, tip]) {
      const row = cell instanceof CompletionExpectation ? new CompletionJob({ expectation: cell }) : cell;
      turn.enqueue(row);
      turn.doneWork.push(turn.queue.shift()!);
    }
    plexus.root.head = turn;
    const visible = [...viewWire(tip)]
      .filter((row) => row.role !== "system")
      .map((row) => ({
        role: row.role,
        content: chatContentText(row.content),
        ...(row.tool_calls == null || row.tool_calls.length === 0
          ? {}
          : { tools: row.tool_calls.map((call) => call.function.name) }),
        ...(row.tool_call_id == null ? {} : { id: row.tool_call_id }),
      }));
    expect(visible).toEqual([
      { role: "user", content: "CARD" },
      { role: "user", content: "sq-user" },
      { role: "assistant", content: "sq-asst" },
      { role: "user", content: "[echo] STORED" },
      { role: "user", content: "keep-user" },
      { role: "assistant", content: "keep-asst", tools: ["edit_file"] },
      { role: "tool", content: "KEEP_FULL", id: "keep_tool" },
      { role: "user", content: "after-user" },
      { role: "assistant", content: "after-asst", tools: ["grep"] },
      { role: "tool", content: "AFTER_FULL", id: "after_tool" },
      { role: "user", content: "tip-user" },
    ] satisfies Array<{ role: ChatMessage["role"]; content: string; tools?: string[]; id?: string }>);
  });
});
