/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
/**
 * An isolated completion's prompt can sit in the kernel's blob bucket while the document keeps its head. The
 * wire carries the whole text through the reader the daemon bound; a blob the bucket lost reaches the model as
 * the head, and the process log names the hash once.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  PromptMessage,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  storedBlobJson,
} from "@inhuman.tools/harness-model";
import { bindBlobReader } from "@inhuman.tools/harness-provider-sdk";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { viewWire } from "../actor.js";

const SHA = "e".repeat(64);
const FULL = `${"Fold this conversation prefix.\n".repeat(400)}Emphasize: the open decisions.`;
const HEAD = FULL.slice(0, 512);

function summarizer(): CompletionExpectation {
  return new CompletionExpectation({
    connectionId: "c1",
    completionMode: "isolated",
    promptMessages: [
      new PromptMessage({ role: "system", content: "Fold this prefix." }),
      new PromptMessage({
        role: "user",
        content: HEAD,
        contentBlobJson: storedBlobJson({
          sha256: SHA,
          bytes: Buffer.byteLength(FULL),
          mime: "text/plain",
          head: HEAD,
        }),
      }),
    ],
  });
}

/** Homes the round on a session, as the daemon does. */
function homed(round: CompletionExpectation): CompletionExpectation {
  const plexus = SessionPlexus.create("wire-blobs", "");
  onTestFinished(() => plexus.destroy());
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`go`, queue: [] });
  turn.pushChild(new CompletionJob({ expectation: round }));
  plexus.root.head = turn;
  return round;
}

beforeEach(() => resetLocalIDs());
afterEach(() => bindBlobReader(null));

describe("viewWire reads bodies stored beside the document", () => {
  it("carries the whole text when the bound reader has the blob", () => {
    const asked: string[] = [];
    bindBlobReader((sha256) => {
      asked.push(sha256);
      return sha256 === SHA ? Buffer.from(FULL, "utf8") : null;
    });
    const chat = [...viewWire(homed(summarizer()))];
    expect({
      rows: chat.map((row) => [row.role, row.content === FULL ? "FULL" : row.content]),
      asked,
    }).toEqual({
      rows: [
        ["system", "Fold this prefix."],
        ["user", "FULL"],
      ],
      asked: [SHA],
    });
  });

  describe("a blob the bucket does not hold", () => {
    let dir = "";
    let logFile = "";
    let savedLog: string | undefined;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "wire-blobs-"));
      logFile = join(dir, "harness.log");
      savedLog = process.env.HARNESS_LOG;
      process.env.HARNESS_LOG = logFile;
    });
    afterEach(() => {
      if (savedLog === undefined) delete process.env.HARNESS_LOG;
      else process.env.HARNESS_LOG = savedLog;
      rmSync(dir, { recursive: true, force: true });
    });

    it("reaches the model as its head, and the log names the hash once however many rounds project it", () => {
      bindBlobReader(() => null);
      const round = homed(summarizer());
      const first = [...viewWire(round)].map((row) => row.content);
      const second = [...viewWire(round)].map((row) => row.content);
      const log = readFileSync(logFile, "utf8");
      const lines = log.split("\n").filter((line) => line.includes(`blob ${SHA}`));
      expect({ first, second, reports: lines.length, failTag: lines[0]?.includes("FAIL") }).toEqual({
        first: ["Fold this prefix.", HEAD],
        second: ["Fold this prefix.", HEAD],
        reports: 1,
        failTag: true,
      });
    });
  });
});
