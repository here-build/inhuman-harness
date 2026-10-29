/**
 * Text behind a blob reaches the tape and the ask pin after the document names it: the Tea
 * paints the face a replica without the prior paints, asks the daemon for the text, and
 * repaints when it lands.
 */
import { FileMutateToolJob, SessionSystemPrompt, storedBlobJson } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { dumpTexts, localClient, openTea, seatTurn, type OpenTea } from "../__visual__/_helpers.js";

const SHA = "c".repeat(64);
const file = `${Array.from({ length: 40 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")}\n`;
const blobJson = storedBlobJson({ sha256: SHA, bytes: file.length, mime: "text/plain", head: file.slice(0, 64) });
const landing = { sha256: SHA, bytes: file.length, mime: "text/plain", text: file, bytesBase64: null };

type Asked = { readonly method: string; readonly params: unknown };

/** The daemon answers `blob/get` when the test says so. */
function mount(job: FileMutateToolJob, options: { readonly ask?: boolean } = {}) {
  const client = localClient();
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: "Change the file",
    ...(options.ask === true ? { permissionMode: "manual" as const } : {}),
    doneWork: [job],
    queue: [],
  });
  if (options.ask === true) {
    turn.pushChild(job);
    client.sessionRoot.permissionMode = "manual";
    client.kernelRoot.approvalAskThrottleMs = 0;
  }
  client.sessionRoot.head = turn;
  const asked: Asked[] = [];
  let settle: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  client.request = (method, params) => {
    asked.push({ method, params });
    return new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  const ui: OpenTea = openTea(client);
  return {
    ui,
    asked,
    land: async (): Promise<void> => {
      settle?.resolve(landing);
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    refuse: async (): Promise<void> => {
      settle?.reject(new Error("unknown blob"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

function edit(fields: { priorBlobJson?: string | null; priorContent?: string | null } = {}) {
  return new FileMutateToolJob({
    toolCallId: "e",
    name: "edit_file",
    argsJson: JSON.stringify({ path: "src/a.ts", old_string: "line-20", new_string: "line-20-edited" }),
    priorBlobJson: blobJson,
    priorLineStart: 21,
    existed: true,
    outcomeJson: '{"ok":true}',
    completed: true,
    ...fields,
  });
}

const tape = (ui: OpenTea): string => dumpTexts(ui.dump().transcript);
const pin = (ui: OpenTea): string => dumpTexts(ui.dump().ask);

test("a sealed edit paints the span, then the file around it once the blob lands", async () => {
  const { ui, asked, land } = mount(edit());
  using _ui = ui;
  expect(asked).toEqual([{ method: "blob/get", params: { sha256: SHA } }]);
  const before = tape(ui);
  expect({
    span: before.includes("-edited"),
    context: before.includes("line-19"),
    elided: before.includes("unchanged"),
  }).toEqual({ span: true, context: false, elided: false });

  await land();
  const after = tape(ui);
  expect({
    span: after.includes("-edited"),
    context: after.includes("line-19") && after.includes("line-21"),
    elided: after.includes("17 unchanged"),
    asked: asked.length,
  }).toEqual({ span: true, context: true, elided: true, asked: 1 });
});

test("an ask for an overwrite has no pin until the old file lands, then holds the diff", async () => {
  const job = new FileMutateToolJob({
    toolCallId: "w",
    name: "write_file",
    argsJson: JSON.stringify({ path: "src/a.ts", content: "replacement\n", overwriteExisting: true }),
    priorBlobJson: blobJson,
    existed: true,
    policyResult: "ask",
  });
  const { ui, asked, land } = mount(job, { ask: true });
  using _ui = ui;
  expect(asked).toEqual([{ method: "blob/get", params: { sha256: SHA } }]);
  expect(pin(ui)).toBe("");

  await land();
  const after = pin(ui);
  expect({ added: after.includes("replacement"), removed: after.includes("line-39") }).toEqual({
    added: true,
    removed: true,
  });
});

test("a blob the daemon does not have leaves the degraded face and is not asked for again at once", async () => {
  const job = edit();
  const { ui, asked, refuse } = mount(job);
  using _ui = ui;
  await refuse();
  // A change to the cell repaints it; the failure is remembered, so no second request goes out.
  job.priorLineStart = 22;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(asked).toHaveLength(1);
  expect(tape(ui).includes("line-19")).toBe(false);
  expect(tape(ui).includes("-edited")).toBe(true);
});

test("an inline prior paints at once and asks for nothing", () => {
  const { ui, asked } = mount(edit({ priorBlobJson: null, priorContent: file }));
  using _ui = ui;
  expect(asked).toEqual([]);
  expect(tape(ui).includes("line-19")).toBe(true);
});
