import { connectionSupports } from "@inhuman.tools/harness-provider-sdk";
import { describe, expect, it } from "vitest";

import { KeylessWebSearchConnection } from "../registrations/index.js";

describe("web registrations", () => {
  it("exposes search/extract methods without a vendor instanceof", async () => {
    const connection = new KeylessWebSearchConnection("web-keyless");
    await connection.ensureBootstrapStarted();
    expect({
      search: connectionSupports(connection, "web-search"),
      extract: connectionSupports(connection, "web-extract"),
      completion: connectionSupports(connection, "completion"),
      vendor: connection.vendor,
      needsAuth: connection.needsAuth,
    }).toEqual({
      search: true,
      extract: true,
      completion: false,
      vendor: "keyless",
      needsAuth: false,
    });
  });
});
