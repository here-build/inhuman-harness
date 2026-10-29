/** Reject non-http(s), credentials-in-URL, and private/reserved hostnames before extract. */

export function publicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http(s) allowed: ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("URL credentials are not allowed");
  }
  assertPublicHost(url.hostname);
  return url;
}

function assertPublicHost(hostname: string): void {
  const h = hostname.toLowerCase().replaceAll(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::" ||
    h === "::1" ||
    h.endsWith(".local") ||
    h === "metadata.google.internal" ||
    h === "metadata.goog" ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(
      h,
    ) ||
    h.startsWith("::ffff:127.") ||
    h.startsWith("::ffff:10.") ||
    h.startsWith("::ffff:192.168.") ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("fe80:")
  ) {
    throw new Error(`blocked host: ${hostname}`);
  }
}
