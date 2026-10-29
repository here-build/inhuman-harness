/**
 * Connect + headers for every `fetch` in this process. Streaming body idle
 * stays on undici's default — a 60s body timeout would kill a live SSE round.
 * Silence from the moment the body opens is `OpenAiCompatActor.stallMs`,
 * including before the first parsed `data:`. This timer counts socket bytes,
 * so an SSE ping resets it; the stall timer does not.
 *
 * Node's bundled fetch keeps a 10s connect timeout that our AbortSignal cannot
 * override. This module's undici Agent + `fetch` replacement is the one timer.
 */
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

export const REQUEST_TIMEOUT_MS = 60_000;

const agent = new Agent({
  connectTimeout: REQUEST_TIMEOUT_MS,
  headersTimeout: REQUEST_TIMEOUT_MS,
});
setGlobalDispatcher(agent);
globalThis.fetch = undiciFetch as unknown as typeof fetch;
