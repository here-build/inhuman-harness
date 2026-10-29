import {
  getChutesAccount,
  getDeepInfraAccount,
  getDeepSeekAccount,
  getMoonshotAccount,
  getNovitaAccount,
  getOpenCodeGoAccount,
  getOpenRouterAccount,
  getPoeAccount,
  getSiliconFlowAccount,
  getTogetherAccount,
  getVeniceAccount,
  getVercelAiGatewayAccount,
  maskSecret,
  type AccountRequest,
  type AccountSnapshot,
} from "./api-extensions/index.js";
import { wellKnownFromBaseUrl } from "./well-known.js";

export type AccountGetter = (req: AccountRequest) => Promise<AccountSnapshot>;

const ACCOUNT_BY_NAME: Record<string, AccountGetter> = {
  OpenRouter: getOpenRouterAccount,
  "Vercel AI Gateway": getVercelAiGatewayAccount,
  DeepSeek: getDeepSeekAccount,
  Moonshot: getMoonshotAccount,
  "Moonshot China": getMoonshotAccount,
  SiliconFlow: getSiliconFlowAccount,
  "SiliconFlow China": getSiliconFlowAccount,
  Poe: getPoeAccount,
  Together: getTogetherAccount,
  Venice: getVeniceAccount,
  Novita: getNovitaAccount,
  DeepInfra: getDeepInfraAccount,
  "OpenCode Go": getOpenCodeGoAccount,
  Chutes: getChutesAccount,
};

export function accountGetterFor(baseUrl: string): AccountGetter | undefined {
  const known = wellKnownFromBaseUrl(baseUrl);
  if (known === undefined) return undefined;
  return ACCOUNT_BY_NAME[known.name];
}

export function paintAccountHint(snap: AccountSnapshot, apiKey?: string): string {
  const mask = snap.identityDetail.key?.mask;
  if (mask !== undefined) return mask;
  if (apiKey !== undefined && apiKey !== "") return maskSecret(apiKey);
  return "";
}
