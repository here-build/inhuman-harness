/**
 * `tip` is a synced pointer next to `head`. Pin = nonempty prompt.
 * Suffix tape keeps blank turns. Torn ceiling collapses to at-tip.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  futurePins,
  futureTurns,
  isAtTip,
  isRewindPin,
  onTipChain,
  pastPins,
  previousPin,
  resolvedTip,
  rewindPinsFrom,
} from "../rewind.js";
import { SessionPlexus } from "../SessionPlexus.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";

function replicaOf(owner: SessionPlexus): { readonly root: SessionPlexus["root"]; [Symbol.dispose](): void } {
  const doc = new Y.Doc({ guid: owner.doc.guid });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(owner.doc));
  const plexus = SessionPlexus.connect(doc);
  return {
    get root() {
      return plexus.root;
    },
    [Symbol.dispose]() {
      plexus.destroy();
      doc.destroy();
    },
  };
}

function turn(tail: SessionSystemPrompt | SessionTurn, text: string): SessionTurn {
  return new SessionTurn({ turnTail: tail, prompt: prompt.user`${text}`, queue: [] });
}

describe("Agent.tip / rewind walks", () => {
  beforeEach(() => resetLocalIDs());

  it("tip rehydrates next to head", () => {
    const plexus = SessionPlexus.create("s-tip", "/tmp/tip");
    const a = turn(new SessionSystemPrompt(), "one");
    const b = turn(a, "two");
    plexus.root.head = b;
    plexus.root.tip = b;
    using replica = replicaOf(plexus);
    expect({
      head: replica.root.head?.uuid,
      tip: replica.root.tip?.uuid,
      agentTip: replica.root.agent.tip?.uuid,
    }).toEqual({
      head: b.uuid,
      tip: b.uuid,
      agentTip: b.uuid,
    });
    plexus.destroy();
  });

  it("pins skip blanks; suffix tape keeps them; torn chain is at-tip", () => {
    const genesis = new SessionSystemPrompt();
    const one = turn(genesis, "one");
    const cont = turn(one, "");
    const emptyCompact = turn(cont, "  ");
    const compactFocus = turn(emptyCompact, "rewrite auth");
    const skill = turn(compactFocus, "/review src");
    const two = turn(skill, "two");
    const fork = turn(genesis, "other session");

    expect({
      pins: rewindPinsFrom(two).map((row) => row.prompt),
      pastFromTwo: pastPins(two).map((row) => row.prompt),
      previousFromTwo: previousPin(two)?.prompt,
      blanks: [cont, emptyCompact].map(isRewindPin),
      compactFocus: isRewindPin(compactFocus),
      skill: isRewindPin(skill),
      atRest: {
        atTip: isAtTip(two, two),
        future: futureTurns(two, two).map((row) => row.prompt),
      },
      rewoundToOne: {
        atTip: isAtTip(one, two),
        resolved: resolvedTip(one, two)?.prompt,
        onChain: [one, cont, emptyCompact, compactFocus, skill, two].map((row) => onTipChain(row, two, one)),
        fork: onTipChain(fork, two, one),
        suffix: futureTurns(one, two).map((row) => row.prompt),
        futurePins: futurePins(one, two).map((row) => row.prompt),
        past: pastPins(one).map((row) => row.prompt),
      },
      torn: {
        resolved: resolvedTip(two, fork)?.prompt,
        atTip: isAtTip(two, fork),
        suffix: futureTurns(two, fork).map((row) => row.prompt),
      },
      nullTip: {
        resolved: resolvedTip(two, null)?.prompt,
        atTip: isAtTip(two, null),
      },
    }).toEqual({
      pins: ["two", "/review src", "rewrite auth", "one"],
      pastFromTwo: ["/review src", "rewrite auth", "one"],
      previousFromTwo: "/review src",
      blanks: [false, false],
      compactFocus: true,
      skill: true,
      atRest: { atTip: true, future: [] },
      rewoundToOne: {
        atTip: false,
        resolved: "two",
        onChain: [true, true, true, true, true, true],
        fork: false,
        suffix: ["", "  ", "rewrite auth", "/review src", "two"],
        futurePins: ["rewrite auth", "/review src", "two"],
        past: [],
      },
      torn: { resolved: "two", atTip: true, suffix: [] },
      nullTip: { resolved: "two", atTip: true },
    });
  });
});
