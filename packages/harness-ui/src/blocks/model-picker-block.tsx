import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { IconCheck, IconChevronRight } from "@tabler/icons-react";

import {
  ConnectStepBlock,
  type ConnectParkForm,
  type ConnectRpcRequest,
  type ConnectStepStart,
} from "./connect-step-block.js";
import { ProviderIcon, accountAnnotation, accountWindowLines, type WireAccount } from "./providers.js";
import { useFloatingPosition } from "../positioning/index.js";
import { Button } from "../primitives/button.js";
import { glyph } from "../primitives/glyph.js";
import { Input } from "../primitives/input.js";
import { useVoice } from "../voice/index.js";

/** A completion wire and one live model id on it. */
export interface ModelChoiceItem {
  readonly connection: string;
  readonly model: string;
}

/** Per-million-token USD rates for a catalog model. */
export interface ModelPricingHint {
  readonly prompt: number;
  readonly completion: number;
  readonly cacheRead?: number;
}

export interface ModelCapabilityItem {
  readonly supportsReasoning?: boolean;
  readonly reasoningEfforts?: readonly string[];
}

export interface OpenRouterProviderInfo {
  readonly key: string;
  readonly label: string;
  readonly icon?: string;
}

/** One completion connection, its live catalog, and its account summary. */
export interface ModelWireItem {
  readonly connection: string;
  readonly name: string;
  readonly choices: readonly ModelChoiceItem[];
  readonly account: WireAccount;
  readonly baseUrl?: string;
  readonly openrouter?: boolean;
  readonly modelNames?: Readonly<Record<string, string>>;
  readonly modelPricing?: Readonly<Record<string, ModelPricingHint>>;
  readonly modelCapabilities?: Readonly<Record<string, ModelCapabilityItem>>;
}

const BADGE_TAGS = new Set(["free", "thinking", "extended", "beta", "preview", "nitro", "online", "floor", "exacto"]);
const SINGLE_PROVIDER_SEARCH_THRESHOLD = 20;

const KNOWN_MODEL_TOKENS: Readonly<Record<string, string | undefined>> = {
  gpt: "GPT",
  gpt4: "GPT-4",
  gpt4o: "GPT-4o",
  gpt5: "GPT-5",
  chatgpt: "ChatGPT",
  glm: "GLM",
  glm4: "GLM-4",
  chatglm: "ChatGLM",
  ai: "AI",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  xai: "xAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  qwen2: "Qwen2",
  "qwen2.5": "Qwen2.5",
  qwen3: "Qwen3",
  "qwen3.5": "Qwen3.5",
  qwen4: "Qwen4",
  qwq: "QwQ",
  qvq: "QvQ",
  minimax: "MiniMax",
  codellama: "CodeLlama",
  starcoder: "StarCoder",
  starcoder2: "StarCoder2",
  deepcoder: "DeepCoder",
  wizardlm: "WizardLM",
  wizardcoder: "WizardCoder",
  internlm: "InternLM",
  internvl: "InternVL",
  olmo: "OLMo",
  olmoe: "OLMoE",
  molmo: "Molmo",
  dbrx: "DBRX",
  rwkv: "RWKV",
  ernie: "ERNIE",
  lfm: "LFM",
  lfm2: "LFM2",
  afm: "AFM",
  nemotron: "Nemotron",
  mixtral: "Mixtral",
  mistral: "Mistral",
  pixtral: "Pixtral",
  codestral: "Codestral",
  ministral: "Ministral",
  magistral: "Magistral",
  devstral: "Devstral",
  claude: "Claude",
  sonnet: "Sonnet",
  haiku: "Haiku",
  opus: "Opus",
  gemini: "Gemini",
  gemma: "Gemma",
  learnlm: "LearnLM",
  grok: "Grok",
  llama: "Llama",
  hermes: "Hermes",
  nous: "Nous",
  sonar: "Sonar",
  r1: "R1",
  v2: "V2",
  "v2.5": "V2.5",
  v3: "V3",
  "v3.1": "V3.1",
  o1: "o1",
  o3: "o3",
  o4: "o4",
  "4o": "4o",
  vl: "VL",
  moe: "MoE",
  it: "IT",
  fp8: "FP8",
  fp16: "FP16",
  bf16: "BF16",
  int4: "INT4",
  int8: "INT8",
  awq: "AWQ",
  gptq: "GPTQ",
  gguf: "GGUF",
};

const OPENROUTER_DEFAULT_PROVIDER: OpenRouterProviderInfo = {
  key: "openrouter",
  label: "OpenRouter",
  icon: "openrouter",
};

const OPENROUTER_PROVIDERS: Readonly<Record<string, OpenRouterProviderInfo | undefined>> = {
  nvidia: { key: "nvidia", label: "NVIDIA", icon: "nvidia" },
  openai: { key: "openai", label: "OpenAI", icon: "openai" },
  anthropic: { key: "anthropic", label: "Anthropic", icon: "anthropic" },
  google: { key: "google", label: "Google", icon: "google" },
  "x-ai": { key: "xai", label: "xAI", icon: "xai" },
  xai: { key: "xai", label: "xAI", icon: "xai" },
  "meta-llama": { key: "meta", label: "Meta", icon: "meta" },
  meta: { key: "meta", label: "Meta", icon: "meta" },
  mistralai: { key: "mistral", label: "Mistral", icon: "mistral" },
  mistral: { key: "mistral", label: "Mistral", icon: "mistral" },
  deepseek: { key: "deepseek", label: "DeepSeek", icon: "deepseek" },
  qwen: { key: "qwen", label: "Qwen", icon: "qwen" },
  cohere: { key: "cohere", label: "Cohere", icon: "cohere" },
  perplexity: { key: "perplexity", label: "Perplexity", icon: "perplexity" },
  microsoft: { key: "microsoft", label: "Microsoft", icon: "microsoft" },
  amazon: { key: "amazon", label: "Amazon", icon: "amazon" },
  aws: { key: "amazon", label: "Amazon", icon: "amazon" },
  moonshotai: { key: "moonshot", label: "Moonshot", icon: "moonshot" },
  moonshot: { key: "moonshot", label: "Moonshot", icon: "moonshot" },
  minimax: { key: "minimax", label: "MiniMax", icon: "minimax" },
  "z-ai": { key: "zai", label: "Z.AI", icon: "zai" },
  zai: { key: "zai", label: "Z.AI", icon: "zai" },
  zhipu: { key: "zai", label: "Z.AI", icon: "zai" },
  thudm: { key: "zai", label: "Z.AI", icon: "zai" },
  openrouter: { key: "openrouter", label: "OpenRouter", icon: "openrouter" },
  huggingface: { key: "huggingface", label: "Hugging Face", icon: "huggingface" },
  huggingfaceh4: { key: "huggingface", label: "Hugging Face", icon: "huggingface" },
  ai21: { key: "ai21", label: "AI21", icon: "ai21" },
  "01-ai": { key: "zeroone", label: "01.AI", icon: "zeroone" },
  zeroone: { key: "zeroone", label: "01.AI", icon: "zeroone" },
  inflection: { key: "inflection", label: "Inflection", icon: "inflection" },
  liquid: { key: "liquid", label: "Liquid", icon: "liquid" },
  "stepfun-ai": { key: "stepfun", label: "StepFun", icon: "stepfun" },
  stepfun: { key: "stepfun", label: "StepFun", icon: "stepfun" },
  tencent: { key: "tencent", label: "Tencent", icon: "tencent" },
  baidu: { key: "baidu", label: "Baidu", icon: "baidu" },
  bytedance: { key: "bytedance", label: "ByteDance", icon: "bytedance" },
  "bytedance-research": { key: "bytedance", label: "ByteDance", icon: "bytedance" },
  alibaba: { key: "alibaba", label: "Alibaba", icon: "alibaba" },
  upstage: { key: "upstage", label: "Upstage", icon: "upstage" },
  snowflake: { key: "snowflake", label: "Snowflake", icon: "snowflake" },
  nousresearch: { key: "nous", label: "Nous Research" },
  nous: { key: "nous", label: "Nous Research" },
  "arcee-ai": { key: "arcee", label: "Arcee AI" },
  arcee: { key: "arcee", label: "Arcee AI" },
  allenai: { key: "allenai", label: "AllenAI" },
};

export function modelChoiceValue(choice: ModelChoiceItem): string {
  return JSON.stringify([choice.connection, choice.model]);
}

export function naturalName(id: string, apiName?: string): string {
  const cleanedApi = apiName === undefined ? "" : stripApiName(apiName);
  if (cleanedApi !== "") return normalizeModelPhrase(cleanedApi);
  const slug = stripBadgesFromSlug(stripVendorPrefix(id.trim()));
  if (slug === "") return id.trim();
  const normalizedSlug = slug
    .replaceAll(/\bcommand-r-plus\b/gi, "Command-R+")
    .replaceAll(/\bcommand-r\+\b/gi, "Command-R+")
    .replaceAll(/\bcommand-r\b/gi, "Command-R")
    .replaceAll(/\bcommand-a\b/gi, "Command-A");
  return normalizedSlug
    .split(/[\s_]+/)
    .flatMap((chunk) => (/^Command-(?:A|R\+?)$/i.test(chunk) ? [chunk] : chunk.split("-")))
    .filter((part) => part !== "")
    .map(formatModelToken)
    .join(" ");
}

export function modelBadges(id: string, apiName?: string, pricing?: ModelPricingHint): string[] {
  const badges: string[] = [];
  const add = (tag: string): void => {
    const clean = tag.trim().toLowerCase();
    if (clean !== "" && BADGE_TAGS.has(clean) && !badges.includes(clean)) badges.push(clean);
  };
  const colonParts = id.trim().split(":");
  for (const part of colonParts.slice(1)) add(part);
  const baseSlug = stripVendorPrefix(colonParts[0] ?? "");
  const dashParts = baseSlug.split("-").filter((part) => part !== "");
  while (dashParts.length > 1) {
    const tail = dashParts[dashParts.length - 1]!.toLowerCase();
    if (!BADGE_TAGS.has(tail)) break;
    add(tail);
    dashParts.pop();
  }
  if (apiName !== undefined) {
    for (const match of apiName.matchAll(/\(([^()]+)\)/g)) {
      add(match[1]!);
    }
  }
  if (pricing?.prompt === 0 && pricing.completion === 0) {
    add("free");
  }
  return badges;
}

export function formatModelPricing(pricing: ModelPricingHint | undefined, badges: readonly string[] = []): string {
  if (badges.includes("free") || (pricing?.prompt === 0 && pricing.completion === 0)) {
    return "free";
  }
  if (pricing === undefined) return "";
  const prompt = formatRate(pricing.prompt);
  const completion = formatRate(pricing.completion);
  if (pricing.cacheRead !== undefined && pricing.cacheRead > 0) {
    return `$${formatRate(pricing.cacheRead)}/$${prompt}/$${completion}`;
  }
  return `$${prompt}/$${completion}`;
}

export function openrouterProvider(modelId: string): OpenRouterProviderInfo {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return OPENROUTER_DEFAULT_PROVIDER;
  const rawSlug = modelId.slice(0, slash).trim().toLowerCase();
  const known = OPENROUTER_PROVIDERS[rawSlug];
  if (known !== undefined) return known;
  return { key: rawSlug, label: naturalName(rawSlug) };
}

interface PreparedChoice {
  readonly choice: ModelChoiceItem;
  readonly value: string;
  readonly label: string;
  readonly badges: readonly string[];
  readonly priceText: string;
  readonly provider?: OpenRouterProviderInfo;
  readonly searchText: string;
}

interface PreparedWire {
  readonly wire: ModelWireItem;
  readonly items: readonly PreparedChoice[];
}

type ViewState = "models" | { readonly start: ConnectStepStart } | { readonly landing: string };

export interface ModelPickerBlockProps {
  readonly wires: readonly ModelWireItem[];
  readonly current: ModelChoiceItem;
  readonly disabled: boolean;
  readonly request: ConnectRpcRequest | null;
  readonly parsePark?: (body: string) => Promise<ConnectParkForm>;
  readonly onChoose: (choice: ModelChoiceItem) => void;
  readonly onLook: (connections: readonly string[], drivers: readonly string[]) => void;
}

/**
 * Pure model switcher menu supporting single-provider lists, multi-provider submenus, inline search, and reconnection.
 */
export function ModelPickerBlock({
  wires,
  current,
  disabled,
  request,
  parsePark,
  onChoose,
  onLook,
}: ModelPickerBlockProps) {
  const voice = useVoice();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const wireRefs = useRef(new Map<string, HTMLDivElement>());
  const submenus = useRef(new Map<string, HTMLDivElement>());
  const shouldScroll = useRef(false);
  const interaction = useRef(0);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [subActive, setSubActive] = useState(0);
  const [view, setView] = useState<ViewState>("models");
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const preparedWires = useMemo<readonly PreparedWire[]>(
    () =>
      wires.map((wire) => ({
        wire,
        items: wire.choices.map((choice) => prepareChoice(wire, choice)),
      })),
    [wires],
  );
  const preparedByConnection = useMemo(
    () => new Map(preparedWires.map((entry) => [entry.wire.connection, entry.items])),
    [preparedWires],
  );

  const singleWire = wires.length === 1 && !wires[0]!.account.needsAuth ? wires[0]! : undefined;
  const showSearch = singleWire == null || singleWire.choices.length > SINGLE_PROVIDER_SEARCH_THRESHOLD;
  const needle = showSearch ? query.trim().toLowerCase() : "";
  const searching = needle !== "";
  const flow = typeof view === "object" && "start" in view ? view.start : null;
  const landing = typeof view === "object" && "landing" in view ? view.landing : null;
  const currentValue = current.model.trim() === "" ? "" : modelChoiceValue(current);
  const currentWire = wires.find((wire) => wire.connection === current.connection);
  const results = useMemo(
    () =>
      searching
        ? preparedWires
            .map(({ wire, items }) => ({
              wire,
              items: items.filter((item) => item.searchText.includes(needle)),
            }))
            .filter((entry) => entry.items.length > 0)
        : [],
    [searching, preparedWires, needle],
  );
  const resultItems = useMemo(() => results.flatMap((entry) => entry.items), [results]);
  const authResults =
    searching && singleWire == null
      ? wires.filter((wire) => wire.account.needsAuth && wire.name.toLowerCase().includes(needle))
      : [];
  const singleItems =
    singleWire == null
      ? []
      : searching
        ? (results[0]?.items ?? [])
        : (preparedByConnection.get(singleWire.connection) ?? []);
  const openWire = searching || singleWire != null ? undefined : wires.find((wire) => wire.connection === open);
  const wireId = (index: number): string => `${id}-wire-${index}`;
  const optionId = (scope: string, index: number): string => `${id}-${scope}-${index}`;

  useFloatingPosition({
    triggerRef,
    floatingRef: root,
    isOpen: visible,
    placement: "top-end",
    offset: 4,
  });

  useEffect(() => {
    if (!shouldScroll.current) return;
    shouldScroll.current = false;
    for (const row of root.current?.querySelectorAll("[data-active]") ?? []) row.scrollIntoView({ block: "nearest" });
  }, [active, subActive, open]);

  const showModels = (wire: ModelWireItem): void => {
    const wireIndex = wires.indexOf(wire);
    if (wireIndex !== -1) setActive(wireIndex);
    if (wire.account.needsAuth) setQuery("");
    if (open !== wire.connection) {
      shouldScroll.current = true;
      setOpen(wire.connection);
      setSubActive(
        wire.account.needsAuth
          ? 0
          : Math.max(
              0,
              wire.choices.findIndex((choice) => modelChoiceValue(choice) === currentValue),
            ),
      );
    }
    const submenu = submenus.current.get(wire.connection);
    if (submenu != null && !submenu.matches(":popover-open")) submenu.showPopover();
  };

  const pick = useCallback(
    (choice: ModelChoiceItem | undefined): void => {
      if (choice == null || wires.find((wire) => wire.connection === choice.connection)?.account.needsAuth) return;
      root.current?.hidePopover();
      onChoose(choice);
    },
    [onChoose, wires],
  );

  const wiresKey = wires
    .map((wire) => `${wire.connection}:${wire.account.needsAuth}:${wire.choices.length}`)
    .join("\0");
  useEffect(() => {
    if (!visible) return;
    onLook(
      wires.map((wire) => wire.connection),
      [],
    );
    return () => onLook([], []);
    // The keys stand for the lists: a new array each render is not a new look.
  }, [visible, wiresKey]);

  useEffect(() => {
    if (landing == null) return;
    const wire = wires.find((candidate) => candidate.connection === landing);
    if (wire == null) return;
    setView("models");
    setActive(wires.indexOf(wire));
    if (wires.length > 1) requestAnimationFrame(() => showModels(wire));
  }, [landing, wiresKey]);

  useEffect(() => {
    if (openWire?.account.needsAuth) setSubActive(0);
    if (open != null && !wires.some((wire) => wire.connection === open)) setOpen(null);
  }, [open, openWire?.account.needsAuth, wiresKey]);

  useEffect(() => {
    if (flow == null) (search.current ?? list.current)?.focus();
  }, [flow, showSearch]);

  const reconnect = (wire: ModelWireItem): void => {
    if (request == null || removing != null) return;
    submenus.current.get(wire.connection)?.hidePopover();
    setOpen(null);
    setView({ start: { driver: "", name: wire.name, reconnect: wire.connection } });
  };

  const remove = async (wire: ModelWireItem): Promise<void> => {
    if (request == null || removing != null) return;
    const mine = interaction.current;
    setRemoving(wire.connection);
    setNotice("");
    try {
      const result = await request("connect/drop", { id: wire.connection, confirm: true });
      if (typeof result !== "object" || result == null || !("ok" in result) || result.ok !== true) {
        throw new Error("Could not delete the provider. Try again.");
      }
      if (mine !== interaction.current) return;
      submenus.current.get(wire.connection)?.hidePopover();
      setOpen(null);
      setActive(0);
    } catch (error) {
      if (mine !== interaction.current) return;
      setNotice(error instanceof Error ? error.message : "Could not delete the provider. Try again.");
    } finally {
      setRemoving(null);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLElement>): void => {
    const length =
      singleWire != null
        ? singleItems.length
        : ((openWire == null ? undefined : openWire.account.needsAuth ? 2 : openWire.choices.length) ??
          (searching ? resultItems.length + authResults.length : wires.length));
    const at = openWire == null ? active : subActive;
    const moves: Partial<Record<string, number>> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: length - 1 };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      if (length > 0) {
        shouldScroll.current = true;
        (openWire == null ? setActive : setSubActive)(Math.max(0, Math.min(length - 1, move)));
      }
      return;
    }
    if (singleWire != null) {
      if (event.key === "Enter") pick(singleItems.at(active)?.choice);
      else return;
    } else if (openWire != null) {
      if (event.key === "Enter") {
        if (openWire.account.needsAuth) {
          if (subActive === 0) reconnect(openWire);
          else void remove(openWire);
        } else pick(openWire.choices.at(subActive));
      }
      if (event.key === "ArrowLeft") submenus.current.get(openWire.connection)?.hidePopover();
    } else if (searching) {
      if (event.key === "Enter") {
        if (active < resultItems.length) pick(resultItems.at(active)?.choice);
        else {
          const wire = authResults.at(active - resultItems.length);
          if (wire != null) showModels(wire);
        }
      }
    } else if (event.key === "Enter" || event.key === "ArrowRight") {
      const wire = wires.at(active);
      if (wire != null) showModels(wire);
    } else {
      return;
    }
    if (event.key === "Enter" || event.key.startsWith("Arrow")) event.preventDefault();
  };

  const activeId =
    singleWire != null
      ? singleItems.length === 0
        ? undefined
        : optionId(searching ? "result" : singleWire.connection, active)
      : openWire != null
        ? optionId(openWire.connection, subActive)
        : searching
          ? active < resultItems.length
            ? optionId("result", active)
            : active < resultItems.length + authResults.length
              ? optionId("auth", active - resultItems.length)
              : undefined
          : active < wires.length
            ? wireId(active)
            : undefined;

  const renderChoices = (
    wire: ModelWireItem,
    items: readonly PreparedChoice[],
    scope: string,
    activeIndex: number,
    onPoint: (index: number) => void,
    startOffset = 0,
  ): ReactNode => {
    if (wire.openrouter && items.some((item) => item.provider !== undefined)) {
      const groups: { provider: OpenRouterProviderInfo; entries: { item: PreparedChoice; index: number }[] }[] = [];
      for (const [idx, item] of items.entries()) {
        const provider = item.provider ?? openrouterProvider(item.choice.model);
        const last = groups.at(-1);
        const index = startOffset + idx;
        if (last?.provider.key === provider.key) {
          last.entries.push({ item, index });
        } else {
          groups.push({ provider, entries: [{ item, index }] });
        }
      }
      return groups.map(({ provider, entries }) => (
        <div className="model-group" key={provider.key} role="group" aria-label={provider.label}>
          <div className="model-group-label" aria-hidden>
            <span>{provider.label}</span>
            {provider.icon === undefined ? null : <ProviderIcon provider={provider.icon} />}
          </div>
          {entries.map(({ item, index }) => (
            <ModelOption
              key={item.value}
              id={optionId(scope, index)}
              item={item}
              index={index}
              selected={item.value === currentValue}
              active={index === activeIndex}
              onPoint={onPoint}
              onPick={pick}
            />
          ))}
        </div>
      ));
    }
    return items.map((item, idx) => {
      const index = startOffset + idx;
      return (
        <ModelOption
          key={item.value}
          id={optionId(scope, index)}
          item={item}
          index={index}
          selected={item.value === currentValue}
          active={index === activeIndex}
          onPoint={onPoint}
          onPick={pick}
        />
      );
    });
  };

  let resultOffset = 0;
  const currentApiName = currentWire?.modelNames?.[current.model];
  const currentPricing = currentWire?.modelPricing?.[current.model];
  const named = current.model.trim() === "" ? "" : naturalName(current.model, currentApiName);
  const currentBadges = current.model.trim() === "" ? [] : modelBadges(current.model, currentApiName, currentPricing);
  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        className="model-trigger"
        popoverTarget={`${id}-root`}
        disabled={disabled}
        aria-label={`${voice.composer.modelLabel}: ${named === "" ? "none chosen" : named}`}
      >
        <span className={named === "" ? "truncate" : "truncate [font-variant-caps:normal] tracking-normal"}>
          {named === "" ? "Choose a model" : named}
        </span>
        {currentBadges.map((badge) => (
          <span key={badge} className="model-badge">
            {badge}
          </span>
        ))}
        {wires.length > 1 && current.connection !== "" ? (
          <span className="text-muted [font-variant-caps:normal] tracking-normal">
            {currentWire?.name ?? current.connection}
          </span>
        ) : null}
      </Button>
      <div
        ref={root}
        id={`${id}-root`}
        popover="auto"
        className="model-menu model-picker"
        onToggle={(event) => {
          if (event.target !== event.currentTarget) return;
          setVisible(event.newState === "open");
          if (event.newState !== "open") {
            interaction.current += 1;
            setOpen(null);
            setView("models");
            return;
          }
          setView("models");
          setQuery("");
          setNotice("");
          setNow(Date.now());
          shouldScroll.current = true;
          if (singleWire != null) {
            setActive(
              Math.max(
                0,
                singleWire.choices.findIndex((choice) => modelChoiceValue(choice) === currentValue),
              ),
            );
          } else {
            setActive(currentWire == null ? 0 : Math.max(0, wires.indexOf(currentWire)));
          }
          (search.current ?? list.current)?.focus();
        }}
      >
        <div className="model-sheet">
          {flow != null && request != null ? (
            <ConnectStepBlock
              key={`${flow.reconnect ?? flow.driver}:${flow.name}`}
              start={flow}
              request={request}
              parsePark={parsePark}
              onDone={(connection) => {
                setQuery("");
                setView({ landing: connection });
              }}
              onCancel={() => setView("models")}
            />
          ) : (
            <>
              <div
                ref={list}
                className="model-list"
                id={`${id}-list`}
                role="listbox"
                aria-label="Models"
                aria-activedescendant={showSearch ? undefined : activeId}
                tabIndex={showSearch ? undefined : -1}
                onKeyDown={showSearch ? undefined : onKey}
              >
                {landing != null ? (
                  <p className="model-empty" role="status">
                    Connected. Loading its models…
                  </p>
                ) : singleWire != null ? (
                  singleItems.length === 0 ? (
                    <p className="model-empty" role="status">
                      No models match
                    </p>
                  ) : (
                    renderChoices(
                      singleWire,
                      singleItems,
                      searching ? "result" : singleWire.connection,
                      active,
                      setActive,
                    )
                  )
                ) : searching ? (
                  results.length === 0 && authResults.length === 0 ? (
                    <p className="model-empty" role="status">
                      No models match
                    </p>
                  ) : (
                    <>
                      {results.length === 1 && results[0]!.wire.openrouter
                        ? renderChoices(results[0]!.wire, results[0]!.items, "result", active, setActive)
                        : results.map(({ wire, items }) => {
                            const start = resultOffset;
                            resultOffset += items.length;
                            return (
                              <div className="model-group" key={wire.connection} role="group" aria-label={wire.name}>
                                {results.length > 1 ? (
                                  <div className="model-group-label" aria-hidden>
                                    <span>{wire.name}</span>
                                  </div>
                                ) : null}
                                {renderChoices(wire, items, "result", active, setActive, start)}
                              </div>
                            );
                          })}
                      {authResults.map((wire, at) => (
                        <div
                          key={wire.connection}
                          className="model-option provider-option"
                          role="option"
                          id={optionId("auth", at)}
                          aria-selected={false}
                          data-active={active === resultItems.length + at ? "" : undefined}
                          onPointerDown={(event) => event.preventDefault()}
                          onPointerMove={() => {
                            const nextIndex = resultItems.length + at;
                            if (active !== nextIndex) setActive(nextIndex);
                          }}
                          onClick={() => showModels(wire)}
                        >
                          <span className="truncate">{wire.name}</span>
                          <IconChevronRight {...glyph} aria-hidden />
                          <span className="provider-note">Please sign in again.</span>
                        </div>
                      ))}
                    </>
                  )
                ) : (
                  wires.map((wire, index) => {
                    const funds = accountAnnotation(wire.account, now);
                    const lines = accountWindowLines(wire.account, now);
                    const accountTitle = [wire.account.failed ? wire.account.detail : "", funds]
                      .filter((bit) => bit !== "")
                      .join("\n");
                    const statusText = wire.account.needsAuth
                      ? "Please sign in again."
                      : wire.account.failed
                        ? wire.account.description
                        : "";
                    const showAccount = statusText !== "" || wire.account.balance !== "" || lines.length > 0;
                    return (
                      <div
                        ref={(node) => {
                          if (node == null) wireRefs.current.delete(wire.connection);
                          else wireRefs.current.set(wire.connection, node);
                        }}
                        className="model-option model-wire"
                        id={wireId(index)}
                        key={wire.connection}
                        role="option"
                        aria-selected={wire === currentWire}
                        aria-haspopup={wire.account.needsAuth ? "menu" : "listbox"}
                        aria-expanded={open === wire.connection}
                        aria-controls={`${id}-submenu-${index}`}
                        data-active={open == null && index === active ? "" : undefined}
                        data-open={open === wire.connection ? "" : undefined}
                        onPointerDown={(event) => event.preventDefault()}
                        onPointerEnter={() => showModels(wire)}
                        onClick={() => showModels(wire)}
                      >
                        <span className="truncate">{wire.name}</span>
                        {showAccount ? (
                          <span className="model-wire-account" title={accountTitle === "" ? undefined : accountTitle}>
                            {statusText !== "" ? (
                              <span data-failed={wire.account.failed ? "" : undefined}>{statusText}</span>
                            ) : lines.length > 0 ? (
                              lines.map((line, at) => (
                                <span
                                  key={`${line.text}:${at}`}
                                  className="model-wire-funds"
                                  data-low={line.low ? "" : undefined}
                                >
                                  {line.text}
                                </span>
                              ))
                            ) : (
                              <span>{wire.account.balance}</span>
                            )}
                          </span>
                        ) : null}
                        <IconChevronRight {...glyph} aria-hidden className="model-wire-chevron shrink-0 text-muted" />
                      </div>
                    );
                  })
                )}
              </div>
              {notice === "" ? null : (
                <p className="model-empty" id={`${id}-notice`} role="alert">
                  {notice}
                </p>
              )}
              {showSearch ? (
                <div className="flex shrink-0 flex-col p-2 text-sm">
                  <Input
                    id={`${id}-search`}
                    ref={search}
                    type="text"
                    role="combobox"
                    className="model-search"
                    placeholder="Search by model name"
                    aria-label="Search by model name"
                    aria-describedby={notice === "" ? undefined : `${id}-notice`}
                    aria-expanded="true"
                    aria-haspopup={openWire?.account.needsAuth ? "menu" : "listbox"}
                    aria-controls={openWire == null ? `${id}-list` : `${id}-submenu-${wires.indexOf(openWire)}`}
                    aria-activedescendant={activeId}
                    value={query}
                    onChange={(event) => {
                      if (open != null) submenus.current.get(open)?.hidePopover();
                      setQuery(event.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKey}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
        {singleWire == null
          ? wires.map((wire, index) => (
              <ModelSubmenuSurface
                key={wire.connection}
                id={id}
                index={index}
                connection={wire.connection}
                name={wire.name}
                needsAuth={wire.account.needsAuth}
                isOpen={open === wire.connection}
                wireRefs={wireRefs}
                submenus={submenus}
                onKeyDown={(event) => {
                  if (!wire.account.needsAuth) return;
                  const next =
                    event.key === "ArrowDown" || event.key === "End"
                      ? 1
                      : event.key === "ArrowUp" || event.key === "Home"
                        ? 0
                        : null;
                  if (next == null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setSubActive(next);
                  [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")].at(next)?.focus();
                }}
                onToggle={(event) => {
                  if (event.newState === "open") {
                    setActive(index);
                    setOpen(wire.connection);
                    setSubActive(
                      Math.max(
                        0,
                        wire.choices.findIndex((choice) => modelChoiceValue(choice) === currentValue),
                      ),
                    );
                  } else {
                    setOpen((shown) => (shown === wire.connection ? null : shown));
                  }
                }}
              >
                {open === wire.connection && wire.account.needsAuth ? (
                  <>
                    <Button
                      variant="ghost"
                      className="model-option justify-start"
                      role="menuitem"
                      id={optionId(wire.connection, 0)}
                      data-active={subActive === 0 ? "" : undefined}
                      disabled={request == null || removing != null}
                      onPointerMove={() => setSubActive(0)}
                      onClick={() => reconnect(wire)}
                    >
                      Sign in again
                    </Button>
                    <Button
                      variant="ghost"
                      className="model-option justify-start"
                      data-destructive=""
                      role="menuitem"
                      id={optionId(wire.connection, 1)}
                      data-active={subActive === 1 ? "" : undefined}
                      disabled={request == null || removing != null}
                      onPointerMove={() => setSubActive(1)}
                      onClick={() => void remove(wire)}
                    >
                      {removing === wire.connection ? "Deleting…" : "Delete"}
                    </Button>
                  </>
                ) : open === wire.connection ? (
                  renderChoices(
                    wire,
                    preparedByConnection.get(wire.connection) ?? [],
                    wire.connection,
                    subActive,
                    setSubActive,
                  )
                ) : null}
              </ModelSubmenuSurface>
            ))
          : null}
      </div>
    </>
  );
}

function ModelSubmenuSurface({
  id,
  index,
  connection,
  name,
  needsAuth,
  isOpen,
  wireRefs,
  submenus,
  onKeyDown,
  onToggle,
  children,
}: {
  readonly id: string;
  readonly index: number;
  readonly connection: string;
  readonly name: string;
  readonly needsAuth: boolean;
  readonly isOpen: boolean;
  readonly wireRefs: RefObject<Map<string, HTMLDivElement>>;
  readonly submenus: RefObject<Map<string, HTMLDivElement>>;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onToggle: ComponentProps<"div">["onToggle"];
  readonly children: ReactNode;
}) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    triggerRef.current = wireRefs.current.get(connection) ?? null;
  }, [wireRefs, connection, isOpen]);

  const isNarrow =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 40rem)").matches;

  useFloatingPosition({
    triggerRef,
    floatingRef: submenuRef,
    isOpen,
    placement: isNarrow ? (needsAuth ? "top-start" : "bottom-start") : "right-start",
    offset: isNarrow ? 8 : 4,
  });

  return (
    <div
      ref={(node) => {
        submenuRef.current = node;
        if (node == null) submenus.current.delete(connection);
        else submenus.current.set(connection, node);
      }}
      id={`${id}-submenu-${index}`}
      popover="auto"
      className="model-menu model-submenu"
      role={needsAuth ? "menu" : "listbox"}
      aria-label={name}
      onKeyDown={onKeyDown}
      onToggle={onToggle}
    >
      {children}
    </div>
  );
}

function prepareChoice(wire: ModelWireItem, choice: ModelChoiceItem): PreparedChoice {
  const apiName = wire.modelNames?.[choice.model];
  const pricing = wire.modelPricing?.[choice.model];
  const label = naturalName(choice.model, apiName);
  const badges = modelBadges(choice.model, apiName, pricing);
  const priceText = wire.openrouter ? formatModelPricing(pricing, badges) : "";
  const provider = wire.openrouter && choice.model.includes("/") ? openrouterProvider(choice.model) : undefined;
  const vendor = provider?.label ?? "";
  return {
    choice,
    value: modelChoiceValue(choice),
    label,
    badges,
    priceText,
    ...(provider === undefined ? {} : { provider }),
    searchText: `${wire.name} ${vendor} ${choice.model} ${label} ${badges.join(" ")}`.toLowerCase(),
  };
}

const ModelOption = memo(function ModelOptionRow({
  id,
  item,
  index,
  selected,
  active,
  onPoint,
  onPick,
}: {
  readonly id: string;
  readonly item: PreparedChoice;
  readonly index: number;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onPoint: (index: number) => void;
  readonly onPick: (choice: ModelChoiceItem) => void;
}) {
  return (
    <div
      className="model-option"
      id={id}
      role="option"
      aria-selected={selected}
      data-active={active ? "" : undefined}
      onPointerDown={(event) => event.preventDefault()}
      onPointerMove={() => {
        if (!active) onPoint(index);
      }}
      onClick={() => onPick(item.choice)}
    >
      <div className="model-option-title">
        <span className="truncate">{item.label}</span>
        {item.badges.map((badge) => (
          <span key={badge} className="model-badge">
            {badge}
          </span>
        ))}
      </div>
      <div className="model-option-meta">
        {item.priceText === "" ? null : <span className="model-pricing">{item.priceText}</span>}
        {selected ? <IconCheck {...glyph} aria-hidden className="shrink-0" /> : null}
      </div>
    </div>
  );
});

function stripVendorPrefix(id: string): string {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return id;
  return id.slice(slash + 1);
}

function stripBadgesFromSlug(slug: string): string {
  const withoutColon = slug.split(":")[0] ?? slug;
  const parts = withoutColon.split("-").filter((part) => part !== "");
  while (parts.length > 1 && BADGE_TAGS.has(parts[parts.length - 1]!.toLowerCase())) {
    parts.pop();
  }
  return parts.join("-");
}

function stripApiName(apiName: string): string {
  let text = apiName.trim();
  const colon = text.indexOf(": ");
  if (colon > 0) text = text.slice(colon + 2).trim();
  text = text
    .replaceAll(/\s*\(([^()]+)\)\s*$/g, (full, inner: string) =>
      BADGE_TAGS.has(inner.trim().toLowerCase()) || inner.trim().toLowerCase() === "self-moderated" ? "" : full,
    )
    .trim();
  return text;
}

function normalizeModelPhrase(phrase: string): string {
  const replaced = phrase
    .replaceAll(/\bcommand[\s-]+r[\s-]+plus\b/gi, "Command-R+")
    .replaceAll(/\bcommand[\s-]+r\+/gi, "Command-R+")
    .replaceAll(/\bcommand[\s-]+r\b/gi, "Command-R")
    .replaceAll(/\bcommand[\s-]+a\b/gi, "Command-A");
  return replaced
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => {
      if (/^Command-(?:A|R\+?)$/i.test(word)) return word;
      if (word.includes("-")) {
        return word
          .split("-")
          .map((sub) => formatModelToken(sub))
          .join("-");
      }
      return formatModelToken(word);
    })
    .join(" ");
}

function formatModelToken(part: string): string {
  if (/^Command-(?:A|R\+?)$/i.test(part)) {
    const suffix = part.slice("Command-".length).toUpperCase();
    return `Command-${suffix}`;
  }
  const lower = part.toLowerCase();
  const known = KNOWN_MODEL_TOKENS[lower];
  if (known !== undefined) return known;
  if (lower.startsWith("a") && lower.endsWith("b") && isNumericToken(lower.slice(1, -1))) {
    return part.toUpperCase();
  }
  if (lower.endsWith("b") || lower.endsWith("m") || lower.endsWith("k")) {
    const unit = lower.slice(-1).toUpperCase();
    const stem = lower.slice(0, -1);
    if (isNumericToken(stem)) return `${stem}${unit}`;
    const xIndex = stem.indexOf("x");
    if (xIndex > 0 && /^\d+$/.test(stem.slice(0, xIndex)) && isNumericToken(stem.slice(xIndex + 1))) {
      return `${stem.slice(0, xIndex)}x${stem.slice(xIndex + 1)}${unit}`;
    }
  }
  return part.charAt(0).toUpperCase() + part.slice(1);
}

function isNumericToken(value: string): boolean {
  if (value === "") return false;
  const parts = value.split(".");
  if (parts.length > 2) return false;
  return parts.every((segment) => segment !== "" && /^\d+$/.test(segment));
}

function formatRate(rate: number): string {
  return Number(rate.toFixed(4)).toString();
}
