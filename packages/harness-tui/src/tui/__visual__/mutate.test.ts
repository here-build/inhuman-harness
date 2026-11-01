import { FileMutateToolJob, SessionSystemPrompt, storedBlobJson, SystemToolJob } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { dumpTexts, localClient, openTea, seatTurn } from "./_helpers.js";

const WRITE_PROMPT = "Write src/hello.ts with a one-line greeting\nthe rest of the app can import.";
const EDIT_PROMPT = "Replace the greeting in src/hello.ts.\nKeep the export name.";

const writeArgs = {
  path: "src/hello.ts",
  content: 'export const greeting = "hello";',
};

const editArgs = {
  path: "src/hello.ts",
  old_string: 'export function greet() {\n  return "hello";\n}',
  new_string: 'export function greet() {\n  return "hi, world";\n}',
};

function mount(leaf: SystemToolJob, prompt: string) {
  const client = localClient();
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt,
    permissionMode: "manual",
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  client.sessionRoot.head = turn;
  client.sessionRoot.permissionMode = "manual";
  client.kernelRoot.approvalAskThrottleMs = 0;
  return openTea(client);
}

function writeJob(
  fields: {
    policyResult?: "ask";
    completed?: boolean;
    outcomeJson?: string;
  } = {},
) {
  return new SystemToolJob({
    toolCallId: "w",
    name: "write_file",
    argsJson: JSON.stringify(writeArgs),
    ...fields,
  });
}

function editJob(
  fields: {
    policyResult?: "ask";
    completed?: boolean;
    outcomeJson?: string;
  } = {},
) {
  return new SystemToolJob({
    toolCallId: "e",
    name: "edit_file",
    argsJson: JSON.stringify(editArgs),
    ...fields,
  });
}

test("write_file tape: prompt → live → ask pin → sealed Diff", () => {
  using live = mount(writeJob(), WRITE_PROMPT);
  expect(live).toMatchScreenshot("write-file-live");

  using asked = mount(writeJob({ policyResult: "ask" }), WRITE_PROMPT);
  expect(asked).toMatchScreenshot("write-file-ask");

  using sealed = mount(writeJob({ completed: true, outcomeJson: '{"ok":true,"text":"wrote"}' }), WRITE_PROMPT);
  expect(sealed).toMatchScreenshot("write-file-ok");
});

test("edit_file tape: prompt → live → ask Diff → sealed Diff", () => {
  using live = mount(editJob(), EDIT_PROMPT);
  expect(live).toMatchScreenshot("edit-file-live");

  using asked = mount(editJob({ policyResult: "ask" }), EDIT_PROMPT);
  expect(asked).toMatchScreenshot("edit-file-ask");

  using sealed = mount(editJob({ completed: true, outcomeJson: '{"ok":true}' }), EDIT_PROMPT);
  expect(sealed).toMatchScreenshot("edit-file-ok");
});

test("write_file caption sits to the right of the path", () => {
  const leaf = writeJob({ completed: true, outcomeJson: '{"ok":true,"text":"wrote"}' });
  leaf.args = { ...writeArgs, description: "Add a greeting" };
  using ui = mount(leaf, WRITE_PROMPT);
  expect(ui).toMatchScreenshot("write-file-ok-caption");
});

test("edit_file caption sits to the right of the path", () => {
  const leaf = editJob({ completed: true, outcomeJson: '{"ok":true}' });
  leaf.args = { ...editArgs, description: "Rename the greeting" };
  using ui = mount(leaf, EDIT_PROMPT);
  expect(ui).toMatchScreenshot("edit-file-ok-caption");
});

const BLOB_SHA = "d".repeat(64);
const blobbedFile = `${Array.from({ length: 40 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")}\n`;

test("edit_file over a prior held in a blob: the span first, the file around it once the text lands", async () => {
  const leaf = new FileMutateToolJob({
    toolCallId: "e",
    name: "edit_file",
    argsJson: JSON.stringify({ path: "src/a.ts", old_string: "line-20", new_string: "line-20-edited" }),
    priorBlobJson: storedBlobJson({
      sha256: BLOB_SHA,
      bytes: blobbedFile.length,
      mime: "text/plain",
      head: blobbedFile.slice(0, 64),
    }),
    priorLineStart: 21,
    existed: true,
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const client = localClient();
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: EDIT_PROMPT,
    doneWork: [leaf],
    queue: [],
  });
  client.sessionRoot.head = turn;
  let land: (value: unknown) => void = () => undefined;
  client.request = (_method, _params) =>
    new Promise((resolve) => {
      land = resolve;
    });
  using ui = openTea(client);
  const face = () => {
    const texts = dumpTexts(ui.dump().transcript);
    return {
      path: texts.includes("src/a.ts"),
      edited: texts.includes("-edited"),
      before: texts.includes("line-19"),
      after: texts.includes("line-21"),
      elided: texts.includes("17 unchanged"),
    };
  };
  // The cache is empty: the diff is the span, numbered from the line the daemon stamped.
  expect(face()).toEqual({ path: true, edited: true, before: false, after: false, elided: false });
  await Promise.resolve(expect(ui).toMatchScreenshot("edit-file-blob-pending"));

  land({
    sha256: BLOB_SHA,
    bytes: blobbedFile.length,
    mime: "text/plain",
    text: blobbedFile,
    bytesBase64: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The cache holds the file: the same call paints against it, with the lines around the change.
  expect(face()).toEqual({ path: true, edited: true, before: true, after: true, elided: true });
  await Promise.resolve(expect(ui).toMatchScreenshot("edit-file-blob-landed"));
});
