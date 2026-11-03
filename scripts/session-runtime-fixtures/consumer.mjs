import "@inhuman.tools/harness-model/session/register";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CompletionExpectation,
  CompletionJob,
  ReACTChunk,
  RegisteredToolsSet,
  SessionTurn,
} from "@inhuman.tools/harness-model/session";
import { SessionRuntime } from "@inhuman.tools/turn/runtime";
import { Transcript, textOfCell } from "@inhuman.tools/turn/context";
import { applyCompact } from "@inhuman.tools/turn/session";
import { bundledCompactProgram } from "@inhuman.tools/turn/resources";
import { reaction } from "mobx";

const fixture = JSON.parse(readFileSync(new URL("./kley-0.1-session.json", import.meta.url), "utf8"));
const runtime = SessionRuntime.restore(fixture.sessionId, Buffer.from(fixture.state, "base64"), { kind: "memory" });
const oldTurn = runtime.root.head;
assert.ok(oldTurn instanceof SessionTurn);
assert.deepEqual({
  path: runtime.root.path,
  prompt: oldTurn.prompt,
  response: oldTurn.doneWork.find((job) => job instanceof CompletionJob)?.expectation.responseText,
}, fixture.expected);
runtime.recover({ kind: "interrupt", message: "Interrupted by the host" });
runtime.activate();

const commandHost = {
  session: runtime.root,
  constitution: "Preserve the conversation and use supplied capabilities.",
  env: () => ({}),
  toolsFor: () => new RegisteredToolsSet(),
  queuedVerbs: () => new Set(),
  cancelOwned: () => {},
};
assert.deepEqual(await runtime.admit(commandHost, { prompt: "Continue the conversation" }, "consumer-command"), {
  ok: true,
  action: "mint",
});
const turn = runtime.root.head;
assert.ok(turn instanceof SessionTurn);
assert.equal(turn.turnTail, oldTurn);
let modelCalls = 0;
await runtime.run(turn, {
  session: runtime.root,
  notes: { peek: () => [], consume: () => {} },
  compactKeepTurns: 1,
  hardCompactTrigger: "",
  admit: () => { throw new Error("Unexpected tool admission"); },
  waitInbound: async () => true,
  openRound: async () => true,
  closeRound: async () => {},
  classifyIntent: async () => ({ verdict: null, status: "unconfigured", detail: "" }),
  startAmbientCompact: () => {},
  resolvers: {
    completion: async (job) => {
      modelCalls += 1;
      job.expectation.responseText = "The upgraded conversation continues.";
      job.expectation.succeed("settled", "supplied-model", "null");
    },
    work: async () => { throw new Error("Unexpected tool execution"); },
    compact: async () => { throw new Error("Unexpected turn compaction"); },
  },
});
const decision = turn.doneWork.findLast((job) => job instanceof ReACTChunk)?.decision;
assert.equal(decision?.kind, "halt");
assert.equal(modelCalls, 1);

let effectCalls = 0;
const effectPort = {
  invoke: async () => {
    effectCalls += 1;
    return { kind: "success", payload: "supplied effect" };
  },
};
const outcome = await runtime.effect("installed-effect", "read", "{}", effectPort, (result) => {
  if (result.kind === "success") runtime.root.applyKvs([{ form: "kv-set", key: "receipt", value: result.payload }]);
});
const checkpoint = runtime.checkpoint();
await runtime[Symbol.asyncDispose]();
runtime.session.destroy();
const restored = SessionRuntime.restore(fixture.sessionId, checkpoint.state, { kind: "memory" });
restored.recover();
restored.activate();
assert.deepEqual(await restored.effect("installed-effect", "read", "{}", effectPort, () => {
  throw new Error("A committed effect was applied twice");
}), outcome);
assert.deepEqual({ calls: effectCalls, receipt: restored.root.kvs.receipt }, { calls: 1, receipt: "supplied effect" });

const home = restored.root.head;
assert.ok(home instanceof SessionTurn);
const stop = reaction(() => [...home.children], (children) => {
  for (const child of children) {
    if (!(child instanceof CompletionJob) || child.expectation.isDone) continue;
    child.expectation.succeed("settled", "supplied-model", "null", {
      result: { text: "Goals and Requests: Preserve the exact user request." },
    });
  }
});
const history = new CompletionExpectation({ connectionId: "host-model", promptText: "Preserve the exact user request." });
history.responseText = "Completed evidence. ".repeat(300);
const transcript = Transcript.fromCells([history]);
const program = bundledCompactProgram();
const compact = await applyCompact(program.source, transcript, transcript, {
  moduleLoader: program.moduleLoader,
  job: home,
  connectionId: "host-model",
  completionModel: "supplied-model",
  forced: true,
});
stop();
assert.equal(compact.ok, true);
assert.ok(compact.ok && compact.checkIn.map(textOfCell).join("\n").includes("Preserve the exact user request."));
await assert.rejects(async () => {
  const key = await program.moduleLoader.resolve("../another-tenant/secret.prompt", "");
  await program.moduleLoader.read(key);
});
await restored[Symbol.asyncDispose]();
restored.session.destroy();

console.log(JSON.stringify({ oldVersion: fixture.version, continued: true, effectCalls, compacted: compact.ok, moduleEscapeDenied: true }));
