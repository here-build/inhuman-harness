/**
 * Remaining-context rail: a `/model` switch must re-base the window at once.
 * The tape keeps the prior model's stamp until a round re-measures it; the
 * rail resolves the live model's catalog window instead of going stale.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  KernelPlexus,
  KernelRoot,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { expect, test } from "vitest";

import type { ComposerPaintInstance } from "../paint-dom.js";
import { Tea } from "../tea.js";

const SMALL = "grok-4";
const LARGE = "grok-4-heavy";
const SMALL_WINDOW = 100_000;
const LARGE_WINDOW = 1_000_000;

function localClient(): Client {
  return new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot({ approvalAskThrottleMs: 0 })),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
}

/** Connection whose live facts advertise two models with different windows. */
function wireClient(): Client {
  const client = localClient();
  const driver = new DriverSpec({
    name: "grok",
    description: "Grok subscription",
    importPath: "test:grok",
    abilityClaim: ["completion"],
    multiplicity: "add-by-default",
  });
  const wire = new ConnectionSpec({ driver, name: "grok" });
  wire.live = { models: [SMALL, LARGE], windows: { [SMALL]: SMALL_WINDOW, [LARGE]: LARGE_WINDOW } };
  client.kernelRoot.drivers = { grok: driver };
  client.kernelRoot.connections = { grok: wire };
  return client;
}

/** Sealed head turn with one round stamped `used` on `model`'s window. */
function stampedHead(model: string, used: number, limit: number): SessionTurn {
  const round = new CompletionExpectation({ connectionId: "grok", model });
  round.totalTokens = used;
  round.contextLimit = limit;
  round.outcome = "successful";
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [new CompletionJob({ expectation: round })],
    queue: [],
  });
  turn.reducerExited = true;
  return turn;
}

function composerOf(tea: Tea): ComposerPaintInstance {
  const composer = tea.paintRoot.children.find((child) => child.kind === "composer");
  if (!(composer !== undefined && "contextLimit" in composer)) throw new Error("no composer paint");
  return composer;
}

function railOf(tea: Tea): { used: number; limit: number; progress: number } {
  const composer = composerOf(tea);
  return {
    used: composer.contextUsed,
    limit: composer.contextLimit,
    progress: composer.progress ?? 0,
  };
}

function openWith(client: Client): Tea {
  const tea = new Tea(client, () => undefined);
  tea.flushPaint();
  return tea;
}

test("head present: model switch rebases the window at once", () => {
  const client = wireClient();
  client.sessionRoot.head = stampedHead(SMALL, 20_000, SMALL_WINDOW);
  client.sessionRoot.applyKvs([
    { form: "kv-set", key: "connection", value: "grok" },
    { form: "kv-set", key: "model", value: SMALL },
  ]);
  using tea = openWith(client);
  // Same model stamped the tape: the rail trusts the tape.
  expect(railOf(tea)).toEqual({ used: 20_000, limit: SMALL_WINDOW, progress: 0.75 });

  client.sessionRoot.applyKvs([{ form: "kv-set", key: "model", value: LARGE }]);
  // Switched before any round ran: the catalog window takes over immediately.
  // Used tokens carry over — the tape did not shrink — but the runway widens.
  expect(railOf(tea)).toEqual({ used: 20_000, limit: LARGE_WINDOW, progress: 0.975 });
});

test("head present: unknown live model keeps the tape window", () => {
  const client = wireClient();
  client.sessionRoot.head = stampedHead(SMALL, 20_000, SMALL_WINDOW);
  client.sessionRoot.applyKvs([
    { form: "kv-set", key: "connection", value: "grok" },
    { form: "kv-set", key: "model", value: SMALL },
  ]);
  using tea = openWith(client);
  // A model the catalog does not list: a stale window beats none.
  client.sessionRoot.applyKvs([{ form: "kv-set", key: "model", value: "unlisted-finetune" }]);
  expect(railOf(tea)).toEqual({ used: 20_000, limit: SMALL_WINDOW, progress: 0.75 });
});

test("head present: live model re-stamps the tape as soon as a round lands", () => {
  const client = wireClient();
  const head = stampedHead(SMALL, 20_000, SMALL_WINDOW);
  client.sessionRoot.head = head;
  client.sessionRoot.applyKvs([
    { form: "kv-set", key: "connection", value: "grok" },
    { form: "kv-set", key: "model", value: LARGE },
  ]);
  using tea = openWith(client);
  expect(railOf(tea).limit).toBe(LARGE_WINDOW);

  // The provider reports the real window for the switched model.
  const round = new CompletionExpectation({ connectionId: "grok", model: LARGE });
  round.totalTokens = 5_000;
  round.contextLimit = LARGE_WINDOW;
  round.outcome = "successful";
  head.doneWork.push(new CompletionJob({ expectation: round }));
  expect(railOf(tea)).toEqual({ used: 5_000, limit: LARGE_WINDOW, progress: 0.99375 });
});

test("no head: rail follows the live model from the catalog", () => {
  const client = wireClient();
  client.sessionRoot.applyKvs([
    { form: "kv-set", key: "connection", value: "grok" },
    { form: "kv-set", key: "model", value: SMALL },
  ]);
  using tea = openWith(client);
  expect(railOf(tea)).toEqual({ used: 0, limit: SMALL_WINDOW, progress: 0 });

  client.sessionRoot.applyKvs([{ form: "kv-set", key: "model", value: LARGE }]);
  expect(railOf(tea)).toEqual({ used: 0, limit: LARGE_WINDOW, progress: 0 });
});
