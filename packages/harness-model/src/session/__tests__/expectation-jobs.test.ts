import { describe, expect, it } from "vitest";

import { parseWebExtractArgs } from "../jobs/WebExtractToolJob.js";
import { parseWebSearchArgs } from "../jobs/WebSearchToolJob.js";

describe("web arg parse", () => {
  it("parseWebSearchArgs clamps limit and accepts q", () => {
    expect({
      q: parseWebSearchArgs('{"q":" hi ","numResults":99}'),
      zero: parseWebSearchArgs('{"query":"x","limit":0}'),
      empty: parseWebSearchArgs("{}"),
    }).toEqual({
      q: { query: "hi", limit: 10 },
      zero: { query: "x", limit: 1 },
      empty: { query: "", limit: 5 },
    });
  });

  it("parseWebExtractArgs clamps charLimit and accepts uri", () => {
    expect({
      uri: parseWebExtractArgs('{"uri":" https://a.test ","maxChars":99}'),
      huge: parseWebExtractArgs('{"url":"https://a.test","charLimit":999999}'),
      empty: parseWebExtractArgs("{}"),
    }).toEqual({
      uri: { url: "https://a.test", charLimit: 256 },
      huge: { url: "https://a.test", charLimit: 100_000 },
      empty: { url: "", charLimit: 15_000 },
    });
  });
});
