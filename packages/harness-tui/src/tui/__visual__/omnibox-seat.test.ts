import { expect, test } from "vitest";

import {
  EMPTY_OMNIBOX,
  omniboxSeat,
  paintOmnibox,
  type OmniboxAsk,
  type OmniboxOverlay,
  type OmniboxQueue,
  type OmniboxSeat,
  type OmniboxSlash,
  type OmniboxValue,
} from "../omnibox-seat.js";

const ask: OmniboxAsk = {
  armed: false,
  persistDeny: false,
  caution: false,
  tier: "Ask",
  classLabels: [],
};
const armed: OmniboxAsk = { ...ask, armed: true };
const slash: OmniboxSlash = { selectedCommandKey: null };
const queue: OmniboxQueue = { stackedBody: "later", queued: 1, running: true };
const overlay: OmniboxOverlay = {
  secret: false,
  inputting: false,
  processing: false,
  placeholder: "Base URL",
  selectedCommandKey: null,
};

function bags(partial: Partial<OmniboxValue>): OmniboxValue {
  return { ...EMPTY_OMNIBOX, ...partial };
}

test("session title paints only in the idle chrome seat", () => {
  expect({
    idle: paintOmnibox(bags({ sessionTitle: "Auth refactor" })).annotation,
    slash: paintOmnibox(bags({ sessionTitle: "Auth refactor", slash })).annotation,
    overlay: paintOmnibox(bags({ sessionTitle: "Auth refactor", overlay })).annotation,
    armedAsk: paintOmnibox(bags({ sessionTitle: "Auth refactor", ask: armed })).annotation,
    queue: paintOmnibox(bags({ sessionTitle: "Auth refactor", queue })).annotation,
    auth: paintOmnibox(bags({ sessionTitle: "Auth refactor", auth: { waiting: true } })).annotation,
    empty: paintOmnibox(bags({ sessionTitle: "" })).annotation,
    askAndSlash: paintOmnibox(bags({ sessionTitle: "Auth refactor", ask, slash })).annotation,
    recap: paintOmnibox(bags({ atTip: false, sessionTitle: "Auth refactor" })).annotation,
  }).toEqual({
    idle: "Auth refactor",
    slash: "Auth refactor",
    overlay: undefined,
    armedAsk: undefined,
    queue: "Auth refactor",
    auth: undefined,
    empty: undefined,
    askAndSlash: undefined,
    recap: "Auth refactor",
  });
});

test("omnibox seat: presence is the claim — overlay beats ask, armed ask beats slash, throttle splits render/input", () => {
  const rows: Array<{ name: string; value: OmniboxValue; seat: OmniboxSeat }> = [
    {
      name: "idle",
      value: EMPTY_OMNIBOX,
      seat: { render: "idle", input: "idle", stack: "none", askChords: "off" },
    },
    {
      name: "queue leftover",
      value: bags({ queue }),
      seat: { render: "queue", input: "queue", stack: "queue", askChords: "off" },
    },
    {
      name: "slash beats queue",
      value: bags({ slash, queue }),
      seat: { render: "slash", input: "slash", stack: "slash", askChords: "off" },
    },
    {
      name: "armed ask beats slash and queue",
      value: bags({ ask: armed, slash, queue }),
      seat: { render: "ask", input: "ask", stack: "ask", askChords: "live" },
    },
    {
      name: "throttle ask over slash: hint ask, keys/stack slash, chords inert",
      value: bags({ ask, slash, queue }),
      seat: { render: "ask", input: "slash", stack: "slash", askChords: "inert" },
    },
    {
      name: "throttle ask over queue, no slash",
      value: bags({ ask, queue }),
      seat: { render: "ask", input: "queue", stack: "queue", askChords: "inert" },
    },
    {
      name: "throttle ask, idle draft",
      value: bags({ ask }),
      seat: { render: "ask", input: "idle", stack: "none", askChords: "inert" },
    },
    {
      name: "overlay beats ask — both bags present",
      value: bags({ overlay, ask: armed, slash, queue }),
      seat: { render: "overlay", input: "overlay", stack: "overlay", askChords: "off" },
    },
    {
      name: "auth beats overlay",
      value: bags({
        auth: { waiting: true },
        overlay,
        ask: armed,
        slash,
        queue,
      }),
      seat: { render: "auth", input: "auth", stack: "auth", askChords: "off" },
    },
  ];

  expect(rows.map((row) => ({ name: row.name, seat: omniboxSeat(row.value) }))).toEqual(
    rows.map((row) => ({ name: row.name, seat: row.seat })),
  );
});

test("paint: overlay placeholder survives a simultaneous ask bag", () => {
  const face = paintOmnibox(
    bags({
      ask: armed,
      overlay: { ...overlay, inputting: true },
    }),
  );
  expect({
    placeholder: face.placeholder,
    mode: face.mode,
    hotkeys: face.hotkeys,
  }).toEqual({
    placeholder: "Base URL",
    mode: "normal",
    hotkeys: undefined,
  });
});

test("paint: continue, retry, and remaining-until-compact progress", () => {
  const progress = paintOmnibox(bags({ progress: 0.4, progressGlowAt: 0.75 }));
  const context = paintOmnibox(bags({ contextUsed: 10_000, contextLimit: 500_000 }));
  expect({
    continue: paintOmnibox(bags({ lastTurnIncomplete: true })).hotkeys,
    continueArmedEsc: paintOmnibox(bags({ lastTurnIncomplete: true, escClearArmed: true })).hotkeys,
    idleArmedEsc: paintOmnibox(bags({ escClearArmed: true })).hotkeys,
    continueOffTip: paintOmnibox(bags({ lastTurnIncomplete: true, atTip: false })).hotkeys,
    retryQueue: paintOmnibox(
      bags({
        queue,
        retrying: true,
        draft: { draft: "", cursor: 0, mark: null },
      }),
    ).hotkeys,
    cancelTurn: paintOmnibox(
      bags({
        queue,
        escClearArmed: true,
        draft: { draft: "", cursor: 0, mark: null },
      }),
    ).hotkeys,
    /**
     * Open work on a *closed* head still paints the queue face, but
     * `findRunningTurn()` is null there, so `turn/cancel` is a no-op.
     * Armed Esc must not advertise an action it cannot perform.
     */
    cancelTurnClosedHead: paintOmnibox(
      bags({
        queue: { stackedBody: "", queued: 0, running: false },
        escClearArmed: true,
        draft: { draft: "", cursor: 0, mark: null },
      }),
    ).hotkeys,
    retryIdle: paintOmnibox(bags({ queue: { stackedBody: "", queued: 0, running: false }, retrying: true })).hotkeys,
    progress: { progress: progress.progress, progressGlowAt: progress.progressGlowAt },
    progressZero: paintOmnibox(bags({ progress: 0, progressGlowAt: 0.75 })).progress,
    context: { contextUsed: context.contextUsed, contextLimit: context.contextLimit },
    emptyProgress: paintOmnibox(EMPTY_OMNIBOX).progress,
    askHidesProgress: paintOmnibox(bags({ ask: armed, progress: 0.4, progressGlowAt: 0.75 })).progress,
    cautionHidesProgress: paintOmnibox(bags({ ask: { ...armed, caution: true }, progress: 0.4, progressGlowAt: 0.75 }))
      .progress,
    cautionContour: paintOmnibox(bags({ ask: { ...armed, caution: true } })).contourRole,
    askContour: paintOmnibox(bags({ ask: armed })).contourRole,
    stackedAskTitle: paintOmnibox(
      bags({
        sessionTitle: "Auth refactor",
        ask: { ...armed, annotation: "run command", stackedBody: "rm file" },
      }),
    ).joinAnnotation,
    editAskTitle: paintOmnibox(bags({ sessionTitle: "Auth refactor", ask: { ...armed, annotation: "edit **a.ts**" } }))
      .joinAnnotation,
  }).toEqual({
    continue: [{ key: "Enter", action: "Resume the interrupted turn", event: "continue" }],
    continueArmedEsc: [{ key: "Esc", action: "Rewind history" }],
    idleArmedEsc: [{ key: "Esc", action: "Rewind history" }],
    continueOffTip: undefined,
    retryQueue: [
      { key: "Enter", action: "steer first", event: "steer-first" },
      { key: "Ctrl+Enter", action: "retry now", event: "retry" },
      { key: "Esc", action: "retract last queued" },
    ],
    cancelTurn: [{ key: "Esc", action: "cancel current turn", event: "cancel-turn" }],
    cancelTurnClosedHead: [{ key: "Esc", action: "Rewind history" }],
    retryIdle: [{ key: "Ctrl+Enter", action: "retry now", event: "retry" }],
    progress: { progress: 0.4, progressGlowAt: 0.75 },
    progressZero: 0,
    context: { contextUsed: 10_000, contextLimit: 500_000 },
    emptyProgress: undefined,
    askHidesProgress: undefined,
    cautionHidesProgress: undefined,
    cautionContour: "emphasis",
    askContour: undefined,
    stackedAskTitle: "Auth refactor",
    editAskTitle: undefined,
  });
});
