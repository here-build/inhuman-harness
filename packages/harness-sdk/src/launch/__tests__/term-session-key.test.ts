import { SessionRoot } from "@inhuman.tools/harness-model";
import { expect, it } from "vitest";

import { termContinuePayload } from "../term-continue.js";
import { termSessionKey } from "../term-session-key.js";

it("forms a key from emulator cookies and every mux pane token", () => {
  const rows = {
    empty: {},
    vscode: { TERM_PROGRAM: "vscode", VSCODE_PID: "1" },
    ghostty: { GHOSTTY_RESOURCES_DIR: "/opt/ghostty" },
    emuColon: { TERM_SESSION_ID: "w0t6p0:382DE265-3313-4497-99F2-9E8EA5BACE2B" },
    emuBare: { TERM_SESSION_ID: "382DE265-3313-4497-99F2-9E8EA5BACE2B" },
    wt: { WT_SESSION: "ed6aaa5a-e2e1-4e0e-9a02-aaaaaaaaaaaa" },
    tmuxA: {
      TERM_SESSION_ID: "w0t6p0:382DE265-3313-4497-99F2-9E8EA5BACE2B",
      TMUX: "/tmp/tmux-501/default,36614,0",
      TMUX_PANE: "%0",
    },
    tmuxB: {
      TERM_SESSION_ID: "w0t6p0:382DE265-3313-4497-99F2-9E8EA5BACE2B",
      TMUX: "/tmp/tmux-501/default,36614,0",
      TMUX_PANE: "%1",
    },
    sockA: { TMUX: "/tmp/tmux-501/a,1,0", TMUX_PANE: "%0" },
    sockB: { TMUX: "/tmp/tmux-501/b,1,0", TMUX_PANE: "%0" },
    pidB: { TMUX: "/tmp/tmux-501/a,2,0", TMUX_PANE: "%0" },
    stacked: {
      TERM_SESSION_ID: "382DE265-3313-4497-99F2-9E8EA5BACE2B",
      TMUX: "/tmp/tmux-501/default,36614,0",
      TMUX_PANE: "%3",
      ZELLIJ_PANE_ID: "7",
      ZELLIJ_SESSION_NAME: "inner",
    },
    screen: { STY: "36069.harnessmux" },
    screenWin: { STY: "36069.harnessmux", WINDOW: "2" },
  } as const;
  expect(Object.fromEntries(Object.entries(rows).map(([name, env]) => [name, termSessionKey(env)]))).toEqual({
    empty: null,
    vscode: null,
    ghostty: null,
    emuColon: "emu=382DE265-3313-4497-99F2-9E8EA5BACE2B",
    emuBare: "emu=382DE265-3313-4497-99F2-9E8EA5BACE2B",
    wt: "emu=ed6aaa5a-e2e1-4e0e-9a02-aaaaaaaaaaaa",
    tmuxA: "emu=382DE265-3313-4497-99F2-9E8EA5BACE2B;tmux_sock=/tmp/tmux-501/default;tmux_pid=36614;tmux_pane=%0",
    tmuxB: "emu=382DE265-3313-4497-99F2-9E8EA5BACE2B;tmux_sock=/tmp/tmux-501/default;tmux_pid=36614;tmux_pane=%1",
    sockA: "tmux_sock=/tmp/tmux-501/a;tmux_pid=1;tmux_pane=%0",
    sockB: "tmux_sock=/tmp/tmux-501/b;tmux_pid=1;tmux_pane=%0",
    pidB: "tmux_sock=/tmp/tmux-501/a;tmux_pid=2;tmux_pane=%0",
    stacked:
      "emu=382DE265-3313-4497-99F2-9E8EA5BACE2B;tmux_sock=/tmp/tmux-501/default;tmux_pid=36614;tmux_pane=%3;zellij_pane=7;zellij_session=inner",
    screen: "screen=36069.harnessmux;screen_win=0",
    screenWin: "screen=36069.harnessmux;screen_win=2",
  });
});

it("stamps conversations only", () => {
  const session = new SessionRoot({ sessionId: "s1", path: "/tmp/p" });
  const env = { TERM_SESSION_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
  const bot = new SessionRoot({ sessionId: "bot", path: "/tmp/p" });
  bot.agent.spec.recipeScope = "global";
  expect({
    conversation: termContinuePayload(env, session),
    bot: termContinuePayload(env, bot),
    noKey: termContinuePayload({}, session),
  }).toEqual({
    conversation: {
      key: "emu=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      sessionId: "s1",
    },
    bot: null,
    noKey: null,
  });
});
