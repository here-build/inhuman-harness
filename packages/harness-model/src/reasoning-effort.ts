/**
 * Closed effort vocabulary. Owned here so the document model does not
 * depend on plugin-sdk or the dotprompt capability.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Type guard for valid reasoning effort values. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return reasoningEffortOf(value) !== null;
}

/** Unknown, empty, and non-strings become null (omit on the wire). */
export function reasoningEffortOf(value: unknown): ReasoningEffort | null {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : null;
}

/** Parse and normalize an arbitrary value into a ReasoningEffort or null. */
export function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") {
    return null;
  }
  return reasoningEffortOf(value.trim().toLowerCase());
}

export type ReasoningCacheImpact = "preserve" | "drops-messages" | "drops-full";

export type ModelReasoningProfile = {
  readonly supportsReasoning: boolean;
  readonly canDisable: boolean;
  readonly supportedEfforts: readonly ReasoningEffort[];
  /** Cache effect when changing between two active effort tiers on a session that already has warm turns on this model. */
  readonly effortSwitchCacheImpact: ReasoningCacheImpact;
  /** Cache effect when toggling only between "none" and an enabled tier on a warm session. */
  readonly toggleCacheImpact: ReasoningCacheImpact;
};

export type ReasoningProfileHint = {
  readonly supportsReasoning?: boolean;
  readonly reasoningEfforts?: readonly ReasoningEffort[];
  readonly baseUrl?: string;
};

const DISABLED_REASONING_PROFILE: ModelReasoningProfile = {
  supportsReasoning: false,
  canDisable: true,
  supportedEfforts: [],
  effortSwitchCacheImpact: "preserve",
  toggleCacheImpact: "preserve",
};

const DEFAULT_ENABLED_REASONING_PROFILE: ModelReasoningProfile = {
  supportsReasoning: true,
  canDisable: true,
  supportedEfforts: ["none", "low", "medium", "high"],
  effortSwitchCacheImpact: "drops-full",
  toggleCacheImpact: "drops-full",
};

function applyHintEfforts(
  profile: ModelReasoningProfile,
  hint?: ReasoningProfileHint,
): ModelReasoningProfile {
  if (!profile.supportsReasoning || !hint?.reasoningEfforts?.length) {
    return profile;
  }
  const efforts: readonly ReasoningEffort[] =
    profile.canDisable && !hint.reasoningEfforts.includes("none")
      ? ["none", ...hint.reasoningEfforts]
      : [...hint.reasoningEfforts];
  return {
    ...profile,
    supportedEfforts: efforts,
  };
}

function classifyNormalizedModel(
  id: string,
  hasThinkingTag: boolean,
  hint?: ReasoningProfileHint,
): ModelReasoningProfile {
  // Anthropic (claude-*)
  if (id.startsWith("claude-")) {
    if (/^claude-(?:[a-z0-9-]+-)?4[.-][56](?:$|[-._:])/.test(id)) {
      return {
        supportsReasoning: true,
        canDisable: true,
        supportedEfforts: ["none", "low", "medium", "high", "max"],
        effortSwitchCacheImpact: "drops-messages",
        toggleCacheImpact: "drops-messages",
      };
    }
    if (
      /^claude-3[.-]7/.test(id) ||
      /^claude-(?:sonnet|opus|haiku)-4/.test(id) ||
      /^claude-4/.test(id)
    ) {
      return {
        supportsReasoning: true,
        canDisable: true,
        supportedEfforts: ["none", "low", "medium", "high"],
        effortSwitchCacheImpact: "drops-messages",
        toggleCacheImpact: "drops-messages",
      };
    }
    if (hasThinkingTag || hint?.supportsReasoning === true) {
      return DEFAULT_ENABLED_REASONING_PROFILE;
    }
    return DISABLED_REASONING_PROFILE;
  }

  // OpenAI / ChatGPT
  if (/^gpt-6/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }
  if (
    /^gpt-5-(?:pro|codex)/.test(id) ||
    /^(?:o1|o3|o4)(?:$|[-._:])/.test(id) ||
    /^gpt-oss/.test(id)
  ) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "medium", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }
  if (/^gpt-5/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }
  if (/^(?:gpt-4|gpt-3\.5|chatgpt-4o)/.test(id)) {
    if (hasThinkingTag || hint?.supportsReasoning === true) {
      return DEFAULT_ENABLED_REASONING_PROFILE;
    }
    return DISABLED_REASONING_PROFILE;
  }

  // DeepSeek
  if (/^deepseek-(?:r1|reasoner)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    };
  }
  if (/^deepseek-(?:v4|4|flash)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "high", "max"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "preserve",
    };
  }
  if (/^deepseek-(?:v3\.1|v3\.2|v3|chat)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    };
  }

  // Qwen / QwQ / QvQ
  if (/^(?:qwq|qvq)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    };
  }
  if (/^qwen[-_]?3[._]8/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "medium", "xhigh"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }
  if (/^qwen[-_]?[34]/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "medium", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "preserve",
    };
  }

  // Kimi / Moonshot
  if (/^(?:kimi-k3|kimi-3|k3)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "high", "max"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }
  if (/^kimi-k2[.-]7/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    };
  }
  if (/^(?:kimi-k2|kimi-thinking)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    };
  }

  // GLM / Z.AI
  if (/^glm-5(?:\.3|\.2|)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "high", "max"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }
  if (/^glm-(?:4\.[567]|z1)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    };
  }

  // xAI / Grok
  if (/^grok-4[.-](?:6|20)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }
  if (/^(?:grok-3-mini|grok-4)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }

  // Google / Gemini
  if (/^(?:gemini-2\.5-pro|gemini-3)/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["minimal", "low", "medium", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }
  if (/^gemini-2\.5/.test(id)) {
    return {
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "minimal", "low", "medium", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    };
  }

  // Other known reasoning families or explicit thinking tag / catalog hint
  if (
    /^magistral/.test(id) ||
    /^minimax-m[12]/.test(id) ||
    /^nemotron.*thinking/.test(id) ||
    hasThinkingTag ||
    hint?.supportsReasoning === true
  ) {
    return DEFAULT_ENABLED_REASONING_PROFILE;
  }

  return DISABLED_REASONING_PROFILE;
}

/**
 * Classify a model identifier (plus optional provider/catalog hints) into its
 * reasoning effort capabilities and prompt-cache invalidation behavior.
 */
export function reasoningProfileFor(
  model: string,
  hint?: ReasoningProfileHint,
): ModelReasoningProfile {
  if (hint?.supportsReasoning === false) {
    return DISABLED_REASONING_PROFILE;
  }

  const trimmed = model.trim().toLowerCase();
  if (!trimmed) {
    if (hint?.supportsReasoning === true) {
      return applyHintEfforts(DEFAULT_ENABLED_REASONING_PROFILE, hint);
    }
    return DISABLED_REASONING_PROFILE;
  }

  const hasThinkingTag = trimmed.includes(":thinking");
  const withoutTag = trimmed.replace(/:thinking\b.*$/, "");
  const normalized = withoutTag.replace(/^(?:[a-z0-9._-]+\/)+/, "");

  const baseProfile = classifyNormalizedModel(normalized, hasThinkingTag, hint);
  return applyHintEfforts(baseProfile, hint);
}

/**
 * Predict the prompt-cache impact of changing reasoning effort from `fromEffort`
 * to `toEffort` on a session that may already have warm turns on the model.
 */
export function willEffortSwitchDropCache(
  profile: ModelReasoningProfile,
  fromEffort: ReasoningEffort | null,
  toEffort: ReasoningEffort | null,
  hasWarmTrajectory: boolean,
): ReasoningCacheImpact {
  if (!hasWarmTrajectory || !profile.supportsReasoning || fromEffort === toEffort) {
    return "preserve";
  }

  const isToggle = (fromEffort === "none") !== (toEffort === "none");
  if (isToggle) {
    return profile.toggleCacheImpact;
  }

  return profile.effortSwitchCacheImpact;
}

/** Format a reasoning effort value for compact UI display. */
export function formatReasoningEffortLabel(effort: ReasoningEffort | "" | null): string {
  if (!effort) {
    return "default";
  }
  if (effort === "none") {
    return "off";
  }
  return effort;
}
