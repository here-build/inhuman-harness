import type { EmptyWaitChrome } from "@inhuman.tools/harness-sdk/text";
import { describe, expect, it } from "vitest";

import { SPINNER_PHASE } from "../spinner-phase.js";
import { waitPhrase, type WaitPhraseReaders } from "../wait-phrase.js";

const connecting: EmptyWaitChrome = {
  kind: "connecting",
  label: "connecting...",
  elapsed: false,
  startedAt: 10,
  retryUntilMs: null,
};

const warmCatalog = { connectionId: "grok", readyState: "ready", modelCount: 3 };

function readers(over: Partial<WaitPhraseReaders> = {}): WaitPhraseReaders {
  return {
    seat: () => "idle",
    historyHides: () => false,
    ask: () => false,
    occupancy: () => null,
    cancel: () => false,
    catalog: () => warmCatalog,
    slash: () => null,
    error: () => "",
    ...over,
  };
}

function unread(name: string): () => never {
  return () => {
    throw new Error(`${name} was read`);
  };
}

describe("waitPhrase", () => {
  it.each(["auth", "overlay"] as const)("%s hides the pin before later facts", (seat) => {
    expect(
      waitPhrase(
        readers({
          seat: () => seat,
          historyHides: unread("history"),
          ask: unread("ask"),
          occupancy: unread("occupancy"),
          cancel: unread("cancel"),
          catalog: unread("catalog"),
          slash: unread("slash"),
          error: unread("error"),
        }),
      ),
    ).toBeNull();
  });

  it("history and an ask pin hide the pin before the census", () => {
    expect(
      waitPhrase(
        readers({
          historyHides: () => true,
          ask: unread("ask"),
          occupancy: unread("occupancy"),
          error: unread("error"),
        }),
      ),
    ).toBeNull();
    expect(
      waitPhrase(
        readers({
          ask: () => true,
          occupancy: unread("occupancy"),
          cancel: unread("cancel"),
          error: unread("error"),
        }),
      ),
    ).toBeNull();
  });

  it("a running turn keeps its phrase and still carries the error", () => {
    expect(
      waitPhrase(
        readers({
          occupancy: () => connecting,
          cancel: unread("cancel"),
          catalog: unread("catalog"),
          slash: unread("slash"),
          error: () => "connection grok needs auth",
        }),
      ),
    ).toEqual({ occupancy: connecting, error: "connection grok needs auth" });
  });

  it("cancel wins over a cold catalog", () => {
    expect(
      waitPhrase(
        readers({
          cancel: () => true,
          catalog: unread("catalog"),
          slash: unread("slash"),
          error: () => "",
        }),
      ),
    ).toEqual({
      occupancy: {
        kind: "waiting",
        label: SPINNER_PHASE.cancelTurn,
        elapsed: false,
        startedAt: null,
        retryUntilMs: null,
      },
      error: "",
    });
  });

  it("a cold /model catalog stalls on loading models", () => {
    expect(
      waitPhrase(
        readers({
          catalog: () => ({ connectionId: "grok", readyState: "bootstrapping", modelCount: 0 }),
          slash: () => "model",
          error: () => "plugin down",
        }),
      ),
    ).toEqual({
      occupancy: {
        kind: "waiting",
        label: SPINNER_PHASE.loadingModels,
        elapsed: false,
        startedAt: null,
        retryUntilMs: null,
      },
      error: "plugin down",
    });
  });

  it("a warm catalog does not read the draft", () => {
    expect(waitPhrase(readers({ slash: unread("slash") }))).toBeNull();
  });

  it("a cold catalog stays quiet until the draft is /model", () => {
    expect(
      waitPhrase(
        readers({
          catalog: () => ({ connectionId: "grok", readyState: null, modelCount: 0 }),
          slash: () => "compact",
        }),
      ),
    ).toBeNull();
  });

  it("an error with no occupancy is its own pin", () => {
    expect(waitPhrase(readers({ error: () => "turn failed" }))).toEqual({
      occupancy: null,
      error: "turn failed",
    });
  });

  it("an idle session with no error is no pin", () => {
    expect(waitPhrase(readers())).toBeNull();
  });
});
