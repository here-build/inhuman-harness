/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
/**
 * blob/vacuum over the session plane: a stored session's large text goes to the kernel's bucket and the stored
 * image shrinks to one snapshot. A dry run counts and writes nothing, and a second run finds nothing.
 */
import { statSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  FileMutateToolJob,
  parseStoredBlob,
  PromptMessage,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { describe, expect, it, onTestFinished } from "vitest";
import * as Y from "yjs";

import { documentImageSegments, documentKey } from "@/protocol/document";
import { DocumentImageStore } from "@/yjs/storage";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";

async function open() {
  const kernel = new KernelDaemon(await realpath(await mkdtemp(join(tmpdir(), "harness-vacuum-k-"))));
  await kernel.ready;
  const path = await realpath(await mkdtemp(join(tmpdir(), "harness-vacuum-p-")));
  const project = new ProjectDaemon(kernel, path);
  await project.ready;
  const session = await project.session("s-vacuum");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { session, kernel };
}

function body(label: string, chars: number): string {
  let text = "";
  for (let line = 1; text.length < chars; line += 1) text += `${label} line ${String(line).padStart(5, "0")}\n`;
  return text.slice(0, chars);
}

const PRIOR = body("prior", 12_000);
const TRANSCRIPT = body("transcript", 600_000);

/** What an older build left in the session: a file's prior text inline, and a summarizer holding its prefix twice. */
function seed(plexus: SessionPlexus) {
  const prior = new FileMutateToolJob({
    toolCallId: "p1",
    name: "edit_file",
    argsJson: "{}",
    existed: true,
    priorContent: PRIOR,
  });
  const summarizer = new CompletionExpectation({
    connectionId: "c1",
    completionMode: "isolated",
    promptText: prompt.user`${TRANSCRIPT}`,
    promptMessages: [
      new PromptMessage({ role: "system", content: "Fold this prefix." }),
      new PromptMessage({ role: "user", content: TRANSCRIPT }),
    ],
  });
  summarizer.succeed("settled", "ok", "null", { result: { text: "ok" } });
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`go`,
    queue: [],
    doneWork: [prior, new CompletionJob({ expectation: summarizer })],
    reducerExited: true,
  });
  return { prior, summarizer };
}

function imageSize(kernel: KernelDaemon): number {
  return statSync(join(kernel.root, ...documentImageSegments("sessions", "s-vacuum"))).size;
}

describe("blob/vacuum", () => {
  it("a dry run counts what would move and leaves the document and the image alone", async () => {
    const { session, kernel } = await open();
    const { prior, summarizer } = seed(session.plexus);
    await kernel.flushSession(session.plexus);
    const size = imageSize(kernel);
    const reply = await session.handleRequest("blob/vacuum", { dryRun: true });
    expect({
      reply,
      image: imageSize(kernel),
      prior: prior.priorContent === PRIOR,
      line: summarizer.promptText === TRANSCRIPT,
    }).toEqual({
      reply: {
        dryRun: true,
        fileMutates: 1,
        promptMessages: 1,
        promptTexts: 1,
        bytesMoved: PRIOR.length + 2 * TRANSCRIPT.length,
        imageBytesBefore: size,
        imageBytesAfter: size,
      },
      image: size,
      prior: true,
      line: true,
    });
  });

  it("moves the text to the bucket and rewrites the image as one snapshot that reads back", async () => {
    const { session, kernel } = await open();
    const { prior, summarizer } = seed(session.plexus);
    await kernel.flushSession(session.plexus);
    const size = imageSize(kernel);
    const reply = (await session.handleRequest("blob/vacuum", {})) as {
      readonly fileMutates: number;
      readonly bytesMoved: number;
      readonly imageBytesBefore: number;
      readonly imageBytesAfter: number;
    };
    const after = imageSize(kernel);
    expect({
      counts: [reply.fileMutates, reply.bytesMoved],
      before: reply.imageBytesBefore === size,
      after: reply.imageBytesAfter === after,
      shrank: size - after > 1_000_000,
      // A session with nothing in it is about 35 KB; the 1.2 MB of text is what was dropped.
      small: after < 60_000,
    }).toEqual({
      counts: [1, PRIOR.length + 2 * TRANSCRIPT.length],
      before: true,
      after: true,
      shrank: true,
      small: true,
    });

    // The live document holds heads and references; the bucket answers for the whole text.
    const priorBlob = parseStoredBlob(prior.priorBlobJson);
    const lineBlob = parseStoredBlob(summarizer.promptTextBlobJson);
    if (priorBlob === null || lineBlob === null) throw new Error("the vacuum left no reference");
    const priorReply = (await session.handleRequest("blob/get", { sha256: priorBlob.sha256 })) as { text: string };
    const lineReply = (await session.handleRequest("blob/get", { sha256: lineBlob.sha256 })) as { text: string };
    expect({ prior: priorReply.text === PRIOR, line: lineReply.text === TRANSCRIPT, same: lineBlob.sha256 }).toEqual({
      prior: true,
      line: true,
      same: parseStoredBlob(summarizer.promptMessages[1]?.contentBlobJson ?? null)?.sha256,
    });

    // What is on disk is a single snapshot of the vacuumed document, and it opens as a session.
    const disk = await new DocumentImageStore(kernel.root).read(documentKey("sessions", "s-vacuum"));
    if (disk === undefined) throw new Error("the image did not read");
    const doc = new Y.Doc({ guid: session.plexus.doc.guid });
    Y.applyUpdate(doc, disk);
    const restored = SessionPlexus.connect(doc);
    try {
      const jobs = restored.getAllOfType(FileMutateToolJob);
      const rounds = restored.getAllOfType(CompletionExpectation);
      expect({
        priorContent: jobs.map((job) => job.priorContent),
        priorReference: jobs.map((job) => parseStoredBlob(job.priorBlobJson)?.sha256),
        lineHead: rounds.map((round) => round.promptText.length),
        messageBodies: rounds.flatMap((round) => round.promptMessages.map((message) => message.body.kind)),
      }).toEqual({
        priorContent: [null],
        priorReference: [priorBlob.sha256],
        lineHead: [512],
        messageBodies: ["inline", "blob"],
      });
    } finally {
      restored.destroy();
      doc.destroy();
    }
  });

  it("a second run finds nothing to move", async () => {
    const { session, kernel } = await open();
    seed(session.plexus);
    await kernel.flushSession(session.plexus);
    await session.handleRequest("blob/vacuum", {});
    const settled = imageSize(kernel);
    const reply = await session.handleRequest("blob/vacuum", {});
    expect(reply).toEqual({
      dryRun: false,
      fileMutates: 0,
      promptMessages: 0,
      promptTexts: 0,
      bytesMoved: 0,
      imageBytesBefore: settled,
      imageBytesAfter: expect.any(Number),
    });
  });

  it("is queued with the writes: it is not exempt from the action queue", async () => {
    const { session } = await open();
    expect(session["queuesExecute"]("blob/vacuum")).toBe(true);
    expect(session["queuesExecute"]("blob/get")).toBe(false);
  });
});
