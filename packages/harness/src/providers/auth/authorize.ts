/**
 * Browser sign-in owned by the daemon. The loopback listener starts when a
 * driver asks, parks `harness/open-url` carrying its callback, and closes
 * when the sign-in settles. Clients only open the URL and answer
 * `{ kind: "opened" }` (or `{ kind: "text", input }` to paste); none hosts a
 * listener, so a browser client signs in the same way the TUI does.
 */

import { fail, step } from "@inhuman.tools/harness-diagnostics";

import {
  listenOAuthLoopback,
  oauthCallbackFor,
  withCallbackParam,
  type OAuthLoopback,
  type OAuthLoopbackListen,
} from "./loopback.js";

/** A sign-in nobody finishes must not hold a port forever. */
export const BROWSER_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export type BrowserAuthorization =
  { readonly pasted: string } | { readonly code: string; readonly state: string; readonly redirectUri: string };

export type BrowserAuthorizeOptions = {
  readonly authUrl: string;
  readonly description: string;
  /**
   * Offer a paste field, named for what it takes: a key, or the address the
   * browser ended on when it runs on another machine than the daemon.
   */
  readonly paste?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Listen address instead of the dialect's (tests keep ChatGPT's fixed port off 1455). */
  readonly listen?: OAuthLoopbackListen;
};

/** The parked UI door: Scheme body in, `ui/resolve` answer out. */
export type BrowserAuthorizeUi = (body: string) => Promise<Readonly<Record<string, unknown>>>;

/** Fixed-port callbacks (ChatGPT's 1455): the live sign-in per `host:port`, so the latest one wins. */
const holders = new Map<string, () => void>();

/**
 * Listen, park the authorize URL, settle on the first of: pasted text, the
 * browser's callback, an error, timeout, abort. A pasted redirect URL carrying
 * `code` is the callback delivered by hand. The listener is always closed.
 */
export async function authorizeInBrowser(
  ui: BrowserAuthorizeUi,
  opts: BrowserAuthorizeOptions,
): Promise<BrowserAuthorization> {
  const dialect = oauthCallbackFor(opts.authUrl);
  const style = { ...dialect, listen: { ...dialect.listen, ...opts.listen } };
  const stop = new AbortController();
  let loopback: OAuthLoopback | undefined;
  const key = style.listen.port === 0 ? undefined : `${style.listen.host}:${style.listen.port}`;
  // Closing here, not in the superseded call's finally: the new listen must find the port free.
  const supersede = (): void => {
    loopback?.close();
    stop.abort(new DOMException("browser sign-in superseded", "AbortError"));
  };
  if (key !== undefined) {
    holders.get(key)?.();
    holders.set(key, supersede);
  }
  const timer = setTimeout(
    () => stop.abort(new Error("browser sign-in timed out")),
    opts.timeoutMs ?? BROWSER_SIGN_IN_TIMEOUT_MS,
  );
  const forward = (): void => stop.abort(opts.signal?.reason ?? new DOMException("aborted", "AbortError"));
  if (opts.signal?.aborted === true) forward();
  else opts.signal?.addEventListener("abort", forward, { once: true });
  /** Work that yields to the first stop: abort, supersede, timeout. */
  const until = async <T>(work: Promise<T>): Promise<T> => {
    let onStop = (): void => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      onStop = () => reject(stop.signal.reason);
      if (stop.signal.aborted) onStop();
      else stop.signal.addEventListener("abort", onStop, { once: true });
    });
    try {
      return await Promise.race([work, stopped]);
    } finally {
      stop.signal.removeEventListener("abort", onStop);
    }
  };

  try {
    loopback = await listenOAuthLoopback(style.listen);
    stop.signal.throwIfAborted();
    const { callbackUrl, wait } = loopback;
    step(`browser sign-in listen ${callbackUrl}`);
    const url = withCallbackParam(opts.authUrl, callbackUrl, style.param);
    const answer = await until(ui(openUrlBody(url, opts.description, opts.paste ?? "")));
    const pasted = typeof answer.input === "string" ? answer.input.trim() : "";
    if (pasted !== "") {
      step(`browser sign-in pasted chars=${pasted.length}`);
      return pastedAuthorization(pasted, callbackUrl);
    }
    const callback = await until(wait);
    step(`browser sign-in callback code=${callback.code.length} state=${callback.state.length}`);
    return { code: callback.code, state: callback.state, redirectUri: callbackUrl };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") step(`browser sign-in ${error.message}`);
    else fail("browser sign-in", error);
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forward);
    loopback?.close();
    if (key !== undefined && holders.get(key) === supersede) holders.delete(key);
  }
}

function pastedAuthorization(pasted: string, redirectUri: string): BrowserAuthorization {
  try {
    const url = new URL(pasted);
    const code = url.searchParams.get("code")?.trim() ?? "";
    if (code !== "") return { code, state: url.searchParams.get("state")?.trim() ?? "", redirectUri };
  } catch {
    /* not a URL: the text itself is the paste */
  }
  return { pasted };
}

function openUrlBody(url: string, description: string, paste: string): string {
  const field = paste === "" ? "" : ` :name ${quote(paste)} :input 'password`;
  return `(harness/open-url :url ${quote(url)} :description ${quote(description)}${field})`;
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
}
