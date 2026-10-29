/** Product driver and intern IDs for the shipped web roster. Not Nous, not Grok. */

export const KEYLESS_DRIVER_NAME = "web-keyless";
export const KEYLESS_CONNECTION_ID = "web-keyless";

export const WEB_DRIVER_NAMES = ["web-keyless", "exa", "parallel", "firecrawl", "keenable", "tavily"] as const;

export type WebDriverName = (typeof WEB_DRIVER_NAMES)[number];
