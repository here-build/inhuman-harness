import { expect, test } from "vitest";

import { clipboardImage, pasteRuns, type ClipboardProbe } from "../clipboard-image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function probe(script: Partial<ClipboardProbe>): ClipboardProbe {
  return {
    platform: "darwin",
    info: "",
    readPng: () => Buffer.alloc(0),
    ...script,
  };
}

test("a png clipboard becomes an image, text is not consulted", async () => {
  const seen = await clipboardImage(
    probe({
      info: "«class PNGf», 4",
      readPng: () => Buffer.from(`«data PNGf${PNG.toString("hex")}»`),
    }),
  );
  expect(seen).toEqual({ id: "clip", mime: "image/png", bytes: PNG });
});

test("no image class reads as no image", async () => {
  expect(await clipboardImage(probe({ info: "«class utf8», 12" }))).toBeNull();
});

test("an image class with an empty read is no image", async () => {
  expect(await clipboardImage(probe({ info: "TIFF picture, 10", readPng: () => Buffer.alloc(0) }))).toBeNull();
});

test("a non-darwin host never reads the clipboard", async () => {
  let read = false;
  expect(
    await clipboardImage(
      probe({
        platform: "linux",
        info: "«class PNGf», 4",
        readPng: () => {
          read = true;
          return PNG;
        },
      }),
    ),
  ).toBeNull();
  expect(read).toBe(false);
});

test("an image on the clipboard becomes a chip and the pasted text is dropped", async () => {
  const runs = await pasteRuns(
    "/tmp/shot.png",
    probe({ info: "«class PNGf», 4", readPng: () => Buffer.from(`«data PNGf${PNG.toString("hex")}»`) }),
  );
  expect(runs).toEqual([{ kind: "image", id: "clip", clipboard: "", submit: `image:image/png:${PNG.length}` }]);
});

test("a path ending in png stays text when the clipboard has no image", async () => {
  expect(await pasteRuns("/tmp/shot.png", probe({ info: "«class utf8», 12" }))).toEqual(["/tmp/shot.png"]);
});
