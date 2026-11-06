import { CompletionExpectation, CompletionJob, SessionSystemPrompt, SystemToolJob } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { PRIOR_PROMPT, dumpTexts, localClient, openTea, seatTurn, sealedCompletion } from "./_helpers.js";

const T1 = "AuthForm imports AUTH_SECRET when the module loads.";
const T2 = "I'll add a request-time lookup helper.";
const T3 = "Keep the export name on the helper.";
const SPEECH = "Request-time lookup lives in src/secret.ts.\nAuthForm keeps the same export name.";

function thoughtOnly(thought: string): CompletionExpectation {
  const completion = sealedCompletion({ text: "", thought });
  completion.responseText = "";
  return completion;
}

function mount() {
  const client = localClient();
  client.sessionRoot.permissionMode = "auto";
  const t1 = thoughtOnly(T1);
  const glob = new SystemToolJob({
    toolCallId: "g",
    name: "glob",
    argsJson: '{"pattern":"**/*.ts"}',
    policyResult: "policyApprove",
    completed: true,
    outcomeJson: '{"ok":true,"text":"src/AuthForm.ts"}',
  });
  const read = new SystemToolJob({
    toolCallId: "r",
    name: "read_file",
    argsJson: '{"path":"src/lookup.ts"}',
    policyResult: "policyApprove",
    completed: true,
    outcomeJson: '{"ok":true,"text":"export function lookup() {}"}',
  });
  const t2 = thoughtOnly(T2);
  const write = new SystemToolJob({
    toolCallId: "w",
    name: "write_file",
    argsJson: '{"path":"src/secret.ts","content":"export function lookup() {}"}',
    policyResult: "ask",
    classifierResult: "allow",
    completed: true,
    outcomeJson: '{"ok":true,"text":"wrote"}',
  });
  const t3 = thoughtOnly(T3);
  const edit = new SystemToolJob({
    toolCallId: "e",
    name: "edit_file",
    argsJson: JSON.stringify({
      path: "src/AuthForm.ts",
      old_string: 'import { AUTH_SECRET } from "./env";\n',
      new_string: 'import { lookup } from "./secret";\n',
    }),
    policyResult: "ask",
    humanApprove: true,
    approvalComment: "keep the export",
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const speech = sealedCompletion({ text: SPEECH, thought: null });
  const work = [t1, glob, read, t2, write, t3, edit, speech].map((chunk) =>
    chunk instanceof CompletionExpectation ? new CompletionJob({ expectation: chunk }) : chunk,
  );
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: PRIOR_PROMPT,
    permissionMode: "auto",
    doneWork: work,
    queue: [],
  });
  for (const chunk of work) turn.pushChild(chunk);
  client.sessionRoot.head = turn;
  return client;
}

function fuseFace(ui: ReturnType<typeof openTea>) {
  const texts = dumpTexts(ui.dump().transcript);
  return {
    glob: texts.includes("**/*.ts"),
    lookup: texts.includes("src/lookup.ts"),
    secret: texts.includes("src/secret.ts"),
    auth: texts.includes("src/AuthForm.ts"),
    comment: texts.includes("keep the export"),
    t2: texts.includes(T2),
    t3: texts.includes(T3),
    speech: texts.includes("Request-time lookup"),
  };
}

test("compact keeps floor-allow calls unless hideFloorTools", () => {
  const client = mount();
  using ui = openTea(client, { tapeExpanded: false });
  expect(fuseFace(ui)).toMatchObject({ glob: true, lookup: true, secret: true, auth: true });
});

test("hideFloorTools fuses floor-allow; judge and human cuts stay visible", () => {
  const client = mount();
  client.kernelRoot.hideFloorTools = true;
  using ui = openTea(client, { tapeExpanded: false });
  const compact = fuseFace(ui);
  ui.setTapeExpanded(true);
  const expanded = fuseFace(ui);
  expect({ compact, expanded }).toEqual({
    compact: {
      glob: false,
      lookup: false,
      secret: true,
      auth: true,
      comment: true,
      t2: true,
      t3: true,
      speech: true,
    },
    expanded: {
      glob: true,
      lookup: true,
      secret: true,
      auth: true,
      comment: true,
      t2: true,
      t3: true,
      speech: true,
    },
  });
  ui.setTapeExpanded(false);
  expect(ui).toMatchScreenshot("tape-fuse-compact");
  ui.setTapeExpanded(true);
  expect(ui).toMatchScreenshot("tape-fuse-expanded");
});
