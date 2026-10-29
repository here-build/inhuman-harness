/** Rewind through qd present: dimmed tape, and the parked recap in the window. */
import { SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { approve, approveLaw } from "./approve.js";
import { presentDump } from "./dump.js";
import { localClient, openTea, sealedCompletion, wrapTurn } from "../__visual__/_helpers.js";

const PROMPTS = [
  "rotate AUTH_SECRET",
  "keep the cookie name",
  "move lookup to request time",
  "clear session on logout",
  "ok",
] as const;

// Each sealed turn is about four rows. Five turns fill a 24-row window, so the
// first recap and the tip still share it. The extra turns make the tape taller
// than two windows: scrolling to the first recap drops the tip.
const PARK_PROMPTS = [
  ...PROMPTS.slice(0, -1),
  "seal the hash at the edge",
  "drop the module cache",
  "hash the form body",
  "drop the import binding",
  "seal the cookie path",
  "move the secret read",
  "ok",
];

function pinChain(prompts: readonly string[]): SessionTurn[] {
  let tail: SessionSystemPrompt | SessionTurn = new SessionSystemPrompt();
  const pins: SessionTurn[] = [];
  for (const prompt of prompts) {
    const turn = wrapTurn(sealedCompletion({ prompt, text: `${prompt}.`, thought: null }), tail);
    pins.push(turn);
    tail = turn;
  }
  return pins;
}

function seatTip(prompts: readonly string[]) {
  const pins = pinChain(prompts);
  const tip = pins.at(-1);
  if (tip === undefined) throw new Error("rewind chain is empty");
  const client = localClient();
  client.sessionRoot.manualTitle = "Auth refactor";
  client.sessionRoot.tip = tip;
  client.sessionRoot.head = tip;
  return openTea(client);
}

function up(ui: ReturnType<typeof openTea>, n: number) {
  ui.tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }] });
  for (let i = 0; i < n; i++) ui.tea.handle({ kind: "input_events", events: [{ key: "ArrowUp" }] });
}

/** The tip prompt, not the "ok" inside "lookup". */
function runIsTipPrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "ok" || trimmed === "ok.";
}

test("rewind-dim", async () => {
  using ui = seatTip(PROMPTS);
  up(ui, 2);
  expect(ui.dump().composer.draft).toBe("move lookup to request time");
  await approve("rewind-dim", ui.tea);
});

test("rewind-park", async () => {
  using ui = seatTip(PARK_PROMPTS);
  up(ui, PARK_PROMPTS.length - 1);
  expect(ui.dump().composer.draft).toBe("rotate AUTH_SECRET");
  await approveLaw("rewind-park", ui.tea, {
    runs: [{ text: "rotate AUTH_SECRET", dim: false }],
  });
  const parked = await presentDump(ui.tea);
  expect(parked.runs.some((run) => runIsTipPrompt(run.text))).toBe(false);
});
