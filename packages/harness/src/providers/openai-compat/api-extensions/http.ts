import { z } from "zod";

import type { AccountRequest } from "./types.js";
import { describeHttpFailure, REQUEST_TIMEOUT_MS, wrapFetchFailure } from "../fetch-failure.js";

/** Account/usage GETs. Same connect/headers budget as every other driver fetch. */
const ACCOUNT_FETCH_MS = REQUEST_TIMEOUT_MS;

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const rel = path.replace(/^\/+/u, "");
  return new URL(rel, `${base}/`).href;
}

export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** Drop a trailing `/v1` so origin-level paths (DeepSeek `/user/balance`, Poe `/usage/...`) resolve. */
export function stripTrailingV1(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/u, "") || "/";
  url.search = "";
  url.hash = "";
  const href = url.href;
  return href.endsWith("/") && url.pathname === "/" ? href.slice(0, -1) : href.replace(/\/+$/u, "");
}

export function parseWire<T>(schema: z.ZodType<T>, json: unknown, provider: string, path: string): T {
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  throw new Error(`${provider} ${path}: ${z.prettifyError(result.error)}`);
}

export async function getJson(req: AccountRequest, url: string, provider: string, path: string): Promise<unknown> {
  const fetchFn = req.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...req.headers,
  };
  if (req.apiKey !== undefined && req.apiKey !== "") {
    headers.Authorization = `Bearer ${req.apiKey}`;
  }
  let response: Response;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ACCOUNT_FETCH_MS);
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
  } catch (error) {
    throw wrapFetchFailure(error, {
      why: `${provider} ${path}`,
      method: "GET",
      url,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      describeHttpFailure({
        why: `${provider} ${path}`,
        method: "GET",
        url,
        status: response.status,
      }),
    );
  }
  try {
    return await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${provider} ${path}: ${message}`);
  }
}
