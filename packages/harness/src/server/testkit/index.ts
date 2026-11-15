/**
 * Integration-test host surface. Not the product daemon API.
 */
export { applyAckAnswer, applyAskAnswer, type AckAnswer, type AskAnswer } from "../ask-answer.js";
export { KernelDaemon, type KernelContour, type KernelDaemonOptions } from "../daemon/kernel/KernelDaemon.js";
export { HarnessDaemon } from "../daemon/server/HarnessDaemon.js";
export { defaultCommands } from "../defaults/index.js";
export { MultiKernelRegistry, type KernelLease, type MultiKernelRegistryOptions } from "../multi-kernel-registry.js";
export { listenCompat as listenCompat } from "./compat-server.js";
export * from "./sequence-provider.js";
