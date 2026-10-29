/** Plugin door: the dist floor and the authorization program. */
export { authorizationProgram } from "./authorize.js";
export { authorize } from "./run-authorization.js";
export { defaultPolicy } from "./bind.js";
export { JUDGE_DEADLINE_MS, withDeadline } from "./deadline.js";
export { checkToolPath, normalizeToolPath } from "./tool-path.js";
export {
  acknowledgeRequest,
  acknowledgeRequirement,
  blockReason,
  floorVerdictOf,
  labelOf,
  mcpOf,
  mergeAcknowledge,
  parseAcknowledge,
  parseAcknowledgeText,
  requestAcknowledgement,
  type AckFlag,
  type AckMatch,
  type AckRequest,
  type AckRequirement,
  type AckSubject,
  type Acknowledger,
} from "./acknowledge.js";
