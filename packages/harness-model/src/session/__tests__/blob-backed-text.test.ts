/**
 * An isolated completion's prompt can leave the document: a message's body (`contentBlobJson`) and a
 * completion's stored line (`promptTextBlobJson`) hold a blob reference, and the text field keeps only the
 * head. `body` / `promptTextBody` read the field either way; `userPrompt` keeps joining the stored `content`.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { storedBlobJson, type StoredBlob } from "../blob-ref.js";
import { CompletionExpectation } from "../expectations/CompletionExpectation.js";
import { PromptMessage } from "../expectations/PromptMessage.js";
import { CompletionJob } from "../jobs/CompletionJob.js";
import { SessionPlexus } from "../SessionPlexus.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";

const SHA = "b".repeat(64);
const HEAD = "Fold this conversation prefix";
const blob: StoredBlob = { sha256: SHA, bytes: 780_000, mime: "text/plain", head: HEAD };

describe("PromptMessage.body", () => {
  beforeEach(() => resetLocalIDs());

  it("is the inline text while no reference is stored", () => {
    const message = new PromptMessage({ role: "user", content: "short" });
    expect({ body: message.body, json: message.contentBlobJson }).toEqual({
      body: { kind: "inline", text: "short" },
      json: null,
    });
  });

  it("is the reference once the body left, and content keeps the head", () => {
    const message = new PromptMessage({ role: "user", content: HEAD, contentBlobJson: storedBlobJson(blob) });
    expect({ body: message.body, content: message.content }).toEqual({
      body: { kind: "blob", blob },
      content: HEAD,
    });
  });

  it("reads a reference that does not parse as the inline text", () => {
    for (const json of ["", "   ", "{", JSON.stringify({ ...blob, sha256: "nope" })]) {
      const message = new PromptMessage({ role: "user", content: HEAD, contentBlobJson: json });
      expect(message.body).toEqual({ kind: "inline", text: HEAD });
    }
  });

  it("follows the fields when they change", () => {
    const message = new PromptMessage({ role: "system", content: "a long body" });
    const before = message.body;
    message.content = HEAD;
    message.contentBlobJson = storedBlobJson(blob);
    const during = message.body;
    message.contentBlobJson = null;
    expect({ before, during, after: message.body }).toEqual({
      before: { kind: "inline", text: "a long body" },
      during: { kind: "blob", blob },
      after: { kind: "inline", text: HEAD },
    });
  });
});

describe("CompletionExpectation prompt bodies", () => {
  beforeEach(() => resetLocalIDs());

  it("promptTextBody reads the stored line inline, by reference, and as inline again on a bad reference", () => {
    const inline = new CompletionExpectation({ connectionId: "c", promptText: prompt.user`what is 2 + 2` });
    const external = new CompletionExpectation({
      connectionId: "c",
      promptText: prompt.user`${HEAD}`,
      promptTextBlobJson: storedBlobJson(blob),
    });
    const corrupt = new CompletionExpectation({
      connectionId: "c",
      promptText: prompt.user`${HEAD}`,
      promptTextBlobJson: "{",
    });
    expect({
      inline: inline.promptTextBody,
      external: external.promptTextBody,
      corrupt: corrupt.promptTextBody,
      none: inline.promptTextBlobJson,
    }).toEqual({
      inline: { kind: "inline", text: "what is 2 + 2" },
      external: { kind: "blob", blob },
      corrupt: { kind: "inline", text: HEAD },
      none: null,
    });
  });

  it("userPrompt keeps joining the stored content: the head of an externalized body, never the whole text", () => {
    const round = new CompletionExpectation({
      connectionId: "c",
      completionMode: "isolated",
      promptMessages: [
        new PromptMessage({ role: "system", content: "system line" }),
        new PromptMessage({ role: "user", content: HEAD, contentBlobJson: storedBlobJson(blob) }),
        new PromptMessage({ role: "user", content: "second" }),
      ],
    });
    expect({
      userPrompt: round.userPrompt,
      bodies: round.promptMessages.map((message) => message.body.kind),
    }).toEqual({ userPrompt: `${HEAD}\n\nsecond`, bodies: ["inline", "blob", "inline"] });
  });

  it("with no user message userPrompt is the stored line, which is the head when the line left", () => {
    const round = new CompletionExpectation({
      connectionId: "c",
      promptText: prompt.user`${HEAD}`,
      promptTextBlobJson: storedBlobJson(blob),
    });
    expect(round.userPrompt).toBe(HEAD);
  });
});

describe("blob references replicate with the document", () => {
  beforeEach(() => resetLocalIDs());

  it("a replica reads the same references and heads", () => {
    const plexus = SessionPlexus.create("s-blob-text", "/tmp/blob-text");
    const replicaDoc = new Y.Doc({ guid: plexus.doc.guid });
    try {
      const round = new CompletionExpectation({
        connectionId: "c",
        completionMode: "isolated",
        promptText: prompt.user`${HEAD}`,
        promptTextBlobJson: storedBlobJson(blob),
        promptMessages: [new PromptMessage({ role: "user", content: HEAD, contentBlobJson: storedBlobJson(blob) })],
      });
      const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`go`, queue: [] });
      turn.pushChild(new CompletionJob({ expectation: round }));
      plexus.root.head = turn;

      Y.applyUpdate(replicaDoc, Y.encodeStateAsUpdate(plexus.doc));
      const replica = SessionPlexus.connect(replicaDoc);
      try {
        const copy = replica.getAllOfType(CompletionExpectation).at(0);
        const message = copy?.promptMessages.at(0);
        expect({
          promptText: copy?.promptText,
          promptTextBody: copy?.promptTextBody,
          content: message?.content,
          body: message?.body,
        }).toEqual({
          promptText: HEAD,
          promptTextBody: { kind: "blob", blob },
          content: HEAD,
          body: { kind: "blob", blob },
        });
      } finally {
        replica.destroy();
      }
    } finally {
      plexus.destroy();
      replicaDoc.destroy();
    }
  });
});
