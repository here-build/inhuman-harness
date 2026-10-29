import { SystemToolJob } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { Dict } from "@/extensions";

import { guardedCallOf } from "../index.js";

describe("narrowed arguments still go through the guard", () => {
  it("host tool mapping writes a narrowed path back into arguments", () => {
    const job = new SystemToolJob({
      toolCallId: "w1",
      name: "write_file",
      argsJson: JSON.stringify({
        path: "/work/src/a.ts",
        content: "x",
        overwriteExisting: true,
      }),
    });
    const call = guardedCallOf(job, "/work")!;
    const next = call.argsFor(new Dict({ paths: ["src/b.ts"], contents: "y" }));
    expect("error" in next ? next.error : next.args).toEqual({
      path: "src/b.ts",
      content: "y",
      overwriteExisting: true,
    });
  });
});
