import { describe, expect, it } from "vitest";

import {
  FIRECRAWL_CLOUD_URL,
  FIRECRAWL_NOUS_GATEWAY_URL,
  KEYLESS_RING,
  WEB_EXTRACT_CAN,
  WEB_SEARCH_CAN,
} from "../wire/index.js";

describe("existing wire IDs", () => {
  it("keeps search/extract cans, keyless ring order, and Firecrawl origins", () => {
    expect({
      search: WEB_SEARCH_CAN,
      extract: WEB_EXTRACT_CAN,
      ring: KEYLESS_RING,
      firecrawl: FIRECRAWL_CLOUD_URL,
      gateway: FIRECRAWL_NOUS_GATEWAY_URL,
    }).toEqual({
      search: "web-search",
      extract: "web-extract",
      ring: ["exa", "parallel", "firecrawl", "keenable", "tavily"],
      firecrawl: "https://api.firecrawl.dev",
      gateway: "https://firecrawl-gateway.nousresearch.com",
    });
  });
});
