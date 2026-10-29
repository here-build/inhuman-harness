import type { ConfigJson } from "../../schemas/well-known.js";

export function applyPluginSet(
  config: ConfigJson,
  args: { readonly name: string; readonly enabled?: boolean; readonly foreground?: boolean },
): void {
  const current = config.plugins[args.name] ?? {};
  config.plugins[args.name] = {
    ...current,
    ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
    ...(args.foreground === undefined ? {} : { foreground: args.foreground }),
  };
}

export function applyConfigSet(
  config: ConfigJson,
  args: {
    readonly compact?: string;
    readonly compactKeepTurns?: number;
    readonly contextRetention?: Readonly<Record<string, unknown>>;
    readonly compactTriggers?: { readonly hard?: string; readonly soft?: string };
    readonly contextGlowRemaining?: string;
    readonly autoModeClassifier?: string;
    readonly defaultPermissionMode?: "manual" | "auto" | "yolo";
    readonly approvalAskThrottleMs?: number;
    readonly shellTailBytes?: number;
    readonly superKey?: "ctrl" | "cmd";
    readonly hideFloorTools?: boolean;
    readonly statusline?: string;
    readonly statuslineRefresh?: string;
    readonly speculativePolicyProcessingTools?: number;
    readonly textOnlyContinue?: boolean;
    readonly authorization?: Record<string, unknown> | null;
  },
): void {
  if (args.compact !== undefined) config.compact = args.compact;
  if (args.compactKeepTurns !== undefined) config.compactKeepTurns = args.compactKeepTurns;
  if (args.contextRetention !== undefined) config.contextRetention = { ...args.contextRetention };
  if (args.compactTriggers !== undefined) {
    config.compactTriggers = { ...config.compactTriggers, ...args.compactTriggers };
  }
  if (args.contextGlowRemaining !== undefined) config.contextGlowRemaining = args.contextGlowRemaining;
  if (args.autoModeClassifier !== undefined) config.autoModeClassifier = args.autoModeClassifier;
  if (args.defaultPermissionMode !== undefined) config.defaultPermissionMode = args.defaultPermissionMode;
  if (args.approvalAskThrottleMs !== undefined) config.approvalAskThrottleMs = args.approvalAskThrottleMs;
  if (args.shellTailBytes !== undefined) config.shellTailBytes = args.shellTailBytes;
  if (args.superKey !== undefined) config.superKey = args.superKey;
  if (args.hideFloorTools !== undefined) config.hideFloorTools = args.hideFloorTools;
  if (args.statusline !== undefined) config.statusline = args.statusline;
  if (args.statuslineRefresh !== undefined) config.statuslineRefresh = args.statuslineRefresh;
  if (args.speculativePolicyProcessingTools !== undefined) {
    config.speculativePolicyProcessingTools = args.speculativePolicyProcessingTools;
  }
  if (args.authorization !== undefined) {
    if (args.authorization === null) delete config.authorization;
    else config.authorization = args.authorization;
  }
  if (args.textOnlyContinue !== undefined) {
    config.reActLoopIntentDetectedTrigger = {
      ...config.reActLoopIntentDetectedTrigger,
      enabled: args.textOnlyContinue,
    };
  }
}
