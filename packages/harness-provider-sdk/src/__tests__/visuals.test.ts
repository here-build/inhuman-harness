import { afterEach, expect, it } from "vitest";

import { bindVisualReader, readVisual } from "../visuals.js";

afterEach(() => bindVisualReader(null));

it("reads nothing until a host binds its store", () => {
  expect(readVisual("s1", "pic")).toBeNull();
});

it("routes a read to the bound reader and stops after it is unbound", () => {
  const seen: string[] = [];
  bindVisualReader((sessionId, id) => {
    seen.push(`${sessionId}/${id}`);
    return id === "pic" ? new Uint8Array([1, 2, 3]) : null;
  });
  expect({ hit: [...(readVisual("s1", "pic") ?? [])], miss: readVisual("s1", "gone"), seen }).toEqual({
    hit: [1, 2, 3],
    miss: null,
    seen: ["s1/pic", "s1/gone"],
  });
  bindVisualReader(null);
  expect(readVisual("s1", "pic")).toBeNull();
});
