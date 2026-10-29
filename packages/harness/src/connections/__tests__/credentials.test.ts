import { describe, expect, it } from "vitest";

import { memoryCredentialsStore, secretsView } from "../index.js";

describe("credentials access", () => {
  it("exposes a PEW secrets view over the host store", () => {
    const store = memoryCredentialsStore({
      grok: { apiKey: "k", refresh: "r" },
    });
    const view = secretsView(store, "grok");
    expect(view.get("apiKey")).toBe("k");
    expect(view.all?.()).toEqual({ apiKey: "k", refresh: "r" });
    view.replace?.({ apiKey: "n" });
    expect(store.read("grok")).toEqual({ apiKey: "n" });
    expect(secretsView(store, "missing").get("apiKey")).toBeUndefined();
  });

  it("does not keep a second bag when write is omitted", () => {
    const store = {
      read: () => ({ apiKey: "k" }),
    };
    const view = secretsView(store, "grok");
    expect(view.replace).toBeUndefined();
    expect(view.get("apiKey")).toBe("k");
  });
});
