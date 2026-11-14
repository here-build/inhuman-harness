import { afterEach, expect, it } from "vitest";

import { bindVisualReader, readVisual, runWithVisualReader } from "../visuals.js";

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

it("isolates concurrent async contexts via runWithVisualReader", async () => {
  bindVisualReader(() => new Uint8Array([99]));
  const [a, b, fallback] = await Promise.all([
    runWithVisualReader(() => new Uint8Array([10]), async () => {
      await new Promise((r) => setTimeout(r, 10));
      return [...(readVisual("s1", "pic") ?? [])];
    }),
    runWithVisualReader(() => new Uint8Array([20]), async () => {
      await new Promise((r) => setTimeout(r, 5));
      return [...(readVisual("s1", "pic") ?? [])];
    }),
    Promise.resolve().then(() => [...(readVisual("s1", "pic") ?? [])]),
  ]);
  expect({ a, b, fallback }).toEqual({ a: [10], b: [20], fallback: [99] });
});
