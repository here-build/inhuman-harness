/**
 * Tab→session cookie. `scope !== ""` is not a continue target (workers).
 */
import type { SessionRoot } from "@inhuman.tools/harness-model";

import { termSessionKey, type EnvBag } from "./term-session-key.js";

export type KernelRequest = (method: string, params?: unknown) => Promise<unknown>;

export function termContinuePayload(
  env: EnvBag,
  session: Pick<SessionRoot, "sessionId" | "agent">,
): { key: string; sessionId: string } | null {
  const key = termSessionKey(env);
  if (key == null || session.agent.spec.recipeScope !== "") return null;
  return { key, sessionId: session.sessionId };
}

export async function stampTermContinue(
  request: KernelRequest,
  env: EnvBag,
  session: Pick<SessionRoot, "sessionId" | "agent">,
): Promise<void> {
  const payload = termContinuePayload(env, session);
  if (payload == null) return;
  await request("term-continue/set", payload);
}

export async function clearTermContinue(request: KernelRequest, key: string): Promise<void> {
  await request("term-continue/clear", { key });
}
