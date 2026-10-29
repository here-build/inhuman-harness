import { execState, toJS, type EnvCapability } from "@here.build/arrival";

import { authorizationSource } from "./authorize.js";

export async function authorize(
  document: string,
  options: {
    readonly capability: EnvCapability;
    readonly config?: Readonly<Record<string, unknown>>;
    readonly program?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<"allow" | "deny" | null> {
  const state = await execState(authorizationSource(options.program, options.env), {
    capabilities: [options.capability],
    config: { ...options.config, document },
  });
  const value = state.values.at(0);
  if (value === undefined) return null;
  const decided = toJS(value);
  if (decided === "allow" || decided === "deny") return decided;
  return null;
}
