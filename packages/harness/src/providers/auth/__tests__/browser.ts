/**
 * What a client does with a parked `harness/open-url`: the browser lands on the
 * daemon's loopback callback, then the client answers `opened`.
 */

/** The authorize URL a parked `harness/open-url` carries. */
export function parkedUrl(body: string): URL {
  const match = /:url "((?:[^"\\]|\\.)*)"/.exec(body);
  if (match?.[1] === undefined) throw new Error(`parked body has no url: ${body}`);
  return new URL(match[1].replaceAll(String.raw`\"`, '"').replaceAll("\\\\", "\\"));
}

/** Where the daemon asked the authorization server to send the browser back. */
export function callbackOf(url: URL): URL {
  const callback = url.searchParams.get("callback_url") ?? url.searchParams.get("redirect_uri");
  if (callback === null) throw new Error(`no callback in ${url}`);
  return new URL(callback);
}

export type OpenedAnswer = { readonly kind: "opened"; readonly url: string };

/** The browser reaches the callback with `params`; the client answers `opened`. */
export async function hitCallback(
  body: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenedAnswer> {
  const url = parkedUrl(body);
  const callback = callbackOf(url);
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  await fetchImpl(callback);
  return { kind: "opened", url: url.toString() };
}

/** The browser signs in at the authorization server, which redirects it to the callback. */
export async function followAuthorize(body: string, fetchImpl: typeof fetch = fetch): Promise<OpenedAnswer> {
  const url = parkedUrl(body);
  const response = await fetchImpl(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (location === null) throw new Error(`authorize ${response.status}: ${await response.text()}`);
  await fetchImpl(location);
  return { kind: "opened", url: url.toString() };
}
