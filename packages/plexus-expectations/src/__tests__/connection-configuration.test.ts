import { describe, expect, it } from "vitest";

import { ConnectionSpec } from "../shared/models/ConnectionSpec.js";
import { DriverSpec } from "../shared/models/DriverSpec.js";

describe("ConnectionSpec.configuration", () => {
  it("exposes a frozen bag and only accepts a whole-bag set", () => {
    const spec = new ConnectionSpec({ driver: new DriverSpec({ name: "x" }) });
    spec.configuration = { baseUrl: "http://local/v1", tags: ["a", "b"] };
    expect(spec.configuration).toEqual({ baseUrl: "http://local/v1", tags: ["a", "b"] });
    expect(Object.isFrozen(spec.configuration)).toBe(true);
    expect(Object.isFrozen(spec.configuration.tags)).toBe(true);
    expect(() => {
      (spec.configuration as { baseUrl: string }).baseUrl = "nope";
    }).toThrow();

    spec.configuration = { baseUrl: "http://local/v2" };
    expect(spec.configuration).toEqual({ baseUrl: "http://local/v2" });

    spec.configuration = undefined;
    expect(spec.configuration).toEqual({});
  });
});
