import { expect, test } from "vitest";

import { readDriverOffers } from "../shared/models/DriverSpec.js";

test("null, blank, and the string null are no offers", () => {
  expect({
    missing: readDriverOffers(null),
    blank: readDriverOffers(""),
    word: readDriverOffers("null"),
    empty: readDriverOffers("[]"),
    one: readDriverOffers('[{"id":"a"}]'),
  }).toEqual({
    missing: [],
    blank: [],
    word: [],
    empty: [],
    one: [{ id: "a" }],
  });
  expect(() => readDriverOffers("not-json")).toThrow(/not valid JSON/);
  expect(() => readDriverOffers(1)).toThrow(/JSON string/);
});
