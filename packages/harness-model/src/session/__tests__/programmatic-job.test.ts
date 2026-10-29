/**
 * ProgrammaticJob is the scheme bag. Printed string[] is text parts; other snaps stringify.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";

describe("ProgrammaticJob", () => {
  beforeEach(() => resetLocalIDs());

  it("expr reads argsJson; printed values are text parts", () => {
    const object = new ProgrammaticJob({
      toolCallId: "c1",
      argsJson: JSON.stringify({ expr: "(+ 1 2)" }),
      outcomeJson: JSON.stringify({ ok: true, value: [true] }),
    });
    const printed = new ProgrammaticJob({
      toolCallId: "c2",
      argsJson: JSON.stringify({ expr: '(+ 1 2)\n(string-append "hello" " " "world")' }),
      outcomeJson: JSON.stringify({ ok: true, value: ["3", "hello world"] }),
    });
    const filed = new ProgrammaticJob({
      toolCallId: "c3",
      argsJson: JSON.stringify({ expr: '(read_file "hello.txt")' }),
      outcomeJson: JSON.stringify({
        ok: true,
        value: [{ text: "hello-from-disk", face: { kind: "file", path: "hello.txt" } }],
      }),
    });
    expect({
      expr: object.expr,
      objectText: object.resultText(),
      objectParts: object.resultParts(),
      printedText: printed.resultText(),
      printedParts: printed.resultParts(),
      filedText: filed.resultText(),
      filedParts: filed.resultParts(),
    }).toEqual({
      expr: "(+ 1 2)",
      objectText: "[true]",
      objectParts: undefined,
      printedText: "3\nhello world",
      printedParts: [
        { type: "text", text: "3" },
        { type: "text", text: "hello world" },
      ],
      filedText: "hello-from-disk",
      filedParts: [{ type: "text", text: "hello-from-disk" }],
    });
  });
});
