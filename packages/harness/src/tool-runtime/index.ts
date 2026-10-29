export * from "@inhuman.tools/turn/tool-runtime";

export type { GuardedCall as GuardedCall } from "./tool-behavior.js";
export {
  agentGuardedCall as agentGuardedCall,
  guardedCallOf as guardedCallOf,
  guardedOutcomeJson as guardedOutcomeJson,
  scopedPath as scopedPath,
} from "./tool-behavior.js";

export * from "./guard-tool.js";
