/** Rewind column: neighbors, in-place recap, one tape. Arrows traverse; head stays. */
import { SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { localClient, openTea, sealedCompletion, wrapTurn } from "./_helpers.js";

const PROMPTS = [
  "rotate AUTH_SECRET",
  "keep the cookie name",
  "move lookup to request time",
  "clear session on logout",
  "ok",
] as const;

function pinChain(): SessionTurn[] {
  let tail: SessionSystemPrompt | SessionTurn = new SessionSystemPrompt();
  const pins: SessionTurn[] = [];
  for (const prompt of PROMPTS) {
    const turn = wrapTurn(sealedCompletion({ prompt, text: `${prompt}.`, thought: null }), tail);
    pins.push(turn);
    tail = turn;
  }
  return pins;
}

function seatTip() {
  const pins = pinChain();
  const client = localClient();
  client.sessionRoot.manualTitle = "Auth refactor";
  client.sessionRoot.tip = pins[4]!;
  client.sessionRoot.head = pins[4]!;
  return { ui: openTea(client), pins };
}

function up(ui: ReturnType<typeof openTea>, n: number) {
  ui.tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }] });
  for (let i = 0; i < n; i++) ui.tea.handle({ kind: "input_events", events: [{ key: "ArrowUp" }] });
}

test("rewind at tip — hidden neighbors, empty omnibox, one tape", () => {
  const { ui } = seatTip();
  expect({
    draft: ui.dump().composer.draft,
    annotation: ui.dump().composer.annotation,
    interactive: ui.dump().composer.interactive,
  }).toEqual({ draft: "", annotation: "Auth refactor", interactive: true });
  expect(ui).toMatchScreenshot("rewind-tip");
});

test("rewind pre-last — recap in tape, no omnibox, one stack below", () => {
  const { ui } = seatTip();
  up(ui, 1);
  expect({
    draft: ui.dump().composer.draft,
    annotation: ui.dump().composer.annotation,
    interactive: ui.dump().composer.interactive,
  }).toEqual({
    draft: "clear session on logout",
    annotation: "Auth refactor",
    interactive: false,
  });
  expect(ui).toMatchScreenshot("rewind-pre-last");
});

test("rewind deep — two above, pin, two below", () => {
  const { ui } = seatTip();
  up(ui, 2);
  expect(ui.dump().composer.draft).toBe("move lookup to request time");
  expect(ui).toMatchScreenshot("rewind-deep");
});

test("rewind first pin — no behind, ahead stack", () => {
  const { ui } = seatTip();
  up(ui, 4);
  expect(ui.dump().composer.draft).toBe("rotate AUTH_SECRET");
  expect(ui).toMatchScreenshot("rewind-first");
});

test("rewind tiny terminal — neighbors shrink, recap stays in tape", () => {
  const { ui } = seatTip();
  up(ui, 2);
  ui.tea.handle({ kind: "resize", cols: 80, rows: 12 });
  expect(ui.dump().composer.draft).toBe("move lookup to request time");
  expect(ui).toMatchScreenshot("rewind-tiny");
});

test("rewind last pin — omnibox seats empty, no scroll-down hint", () => {
  const { ui } = seatTip();
  up(ui, 0);
  // The view sits on the head, which is the episode ceiling: the empty
  // omnibox block seats at the rim and the ahead stack is dropped. The
  // recap keeps the previous-message hint in the tape.
  expect(ui).toMatchScreenshot("rewind-last");
  expect({
    draft: ui.dump().composer.draft,
    hints: ui.dump().composer.hints,
    interactive: ui.dump().composer.interactive,
  }).toEqual({ draft: "", hints: [], interactive: true });
});
