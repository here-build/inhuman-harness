// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Plexus } from "@here.build/plexus";
import {
  CompletionExpectation,
  CompletionJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { Tape } from "@inhuman.tools/harness-transcript";
import { runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewProvider } from "../file-sidebar.js";
import * as tapeRead from "../tape-read.js";

const seen = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock("remend", () => ({
  default: (text: string) => {
    seen.texts.push(text);
    return text;
  },
}));

vi.mock("../../client/context.js", () => ({
  useDial: () => state.dial,
}));

const state = vi.hoisted(() => ({
  dial: {
    link: null as { kind: string } | null,
    attaching: false,
    kernel: { root: { sessions: {} as Record<string, unknown> } },
    project: null,
    session: null as { root: SessionRoot } | null,
    follow: () => undefined,
    requestedTarget: { kind: "kernel" as const },
  },
}));

function completion(text: string): CompletionJob {
  const expectation = new CompletionExpectation({ connectionId: "test" });
  expectation.responseText = text;
  return new CompletionJob({ expectation });
}

function seat(turn: SessionTurn, jobs: readonly CompletionJob[]): void {
  for (const job of jobs) turn.pushChild(job);
}

describe("tape projection", () => {
  let container: HTMLDivElement;
  let view: Root;
  let release: (() => void) | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    seen.texts = [];
    state.dial.session = null;
    container = document.createElement("div");
    document.body.append(container);
    view = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      view.unmount();
    });
    container.remove();
    release?.();
    release = null;
  });

  it("reparses only the speech whose text changed", async () => {
    const olderSpeech = completion("old");
    const stable = completion("stable");
    const growing = completion("growing");
    const older = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [olderSpeech],
      reducerExited: true,
    });
    const newer = new SessionTurn({
      turnTail: older,
      queue: [],
      doneWork: [stable, growing],
      reducerExited: true,
    });
    seat(older, [olderSpeech]);
    seat(newer, [stable, growing]);
    const root = new SessionRoot({ sessionId: "s", path: "/tmp/web" });
    root.head = newer;
    const booted = Plexus.bootstrap(root);
    release = () => {
      booted.destroy();
    };
    state.dial.session = { root };

    await act(async () => {
      view.render(createElement(FilePreviewProvider, { resetKey: "s" }, createElement(Tape)));
    });
    seen.texts = [];
    const projectTurn = vi.spyOn(tapeRead, "projectTurn");

    await act(async () => {
      runInAction(() => {
        growing.expectation.responseText = "growing more";
      });
    });

    expect(container.textContent).toContain("growing more");
    expect(container.textContent).toContain("old");
    expect(container.textContent).toContain("stable");
    expect(seen.texts).toEqual(["growing more"]);
    expect(projectTurn.mock.calls.map((call) => call[0])).toEqual([newer]);
  });
});
