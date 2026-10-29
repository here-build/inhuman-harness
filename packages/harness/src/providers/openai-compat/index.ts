/**
 * @inhuman.tools/harness-provider-openai-compat — generic Chat Completions
 * and Responses codecs, PEW connection, leftover completion actors.
 *
 * Vendor packages and product roster stay out. Generic endpoint registration
 * is `./register`.
 */

export * from "./connection.js";
export * from "./cache-affinity.js";
export * from "./actor.js";
export { bindCompletionFace as bindCompletionFace } from "./completion-face.js";
export { type OpenAiTool as OpenAiTool } from "./arg-aliases.js";
export {
  accountFromChatGptUsage as accountFromChatGptUsage,
  chatgptUsageUrl as chatgptUsageUrl,
  CHATGPT_USAGE_PATH as CHATGPT_USAGE_PATH,
} from "./api-extensions/chatgpt-usage.js";
export {
  accountFromGrokBilling as accountFromGrokBilling,
  GROK_BILLING_PATH as GROK_BILLING_PATH,
} from "./api-extensions/grok-billing.js";
export {
  getChatGptAccount as getChatGptAccount,
  getGrokAccount as getGrokAccount,
  getOpenRouterAccount as getOpenRouterAccount,
  maskSecret as maskSecret,
  type AccountRequest as AccountRequest,
  type AccountSnapshot as AccountSnapshot,
} from "./api-extensions/index.js";
export { describeHttpFailure as describeHttpFailure, wrapFetchFailure as wrapFetchFailure } from "./fetch-failure.js";
export * from "./schema.js";
