import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { clipboardImage } from "../clipboard-image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x63, 0x6c, 0x69, 0x70]);

test.skipIf(process.platform !== "darwin" || process.env.CLIPBOARD_E2E !== "1")(
  "a png put on the macOS pasteboard reads back",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "clip-"));
    const file = join(dir, "clip.png");
    writeFileSync(file, PNG);
    const saved = execFileSync("osascript", ["-e", "clipboard info"], { encoding: "utf8" });
    try {
      execFileSync("osascript", [
        "-e",
        `set the clipboard to (read POSIX file ${JSON.stringify(file)} as «class PNGf»)`,
      ]);
      return clipboardImage().then((seen) => {
        expect(seen?.mime).toBe("image/png");
        expect(seen?.bytes.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
        return seen;
      });
    } finally {
      execFileSync("osascript", ["-e", `set the clipboard to ${JSON.stringify(saved.trim())}`]);
    }
  },
);
