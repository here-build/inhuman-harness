import { asSystemPrompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import { agentNatureOf, reasoningEffortOf, type RecipeScope, type ReasoningEffort } from "@inhuman.tools/harness-model";

import { cloneDraftPicture, type DraftPicture } from "./draft-slot.js";
import type { ModelChoice } from "./model-choice.js";
import { turnVisualPayload } from "./picture-draft.js";

export type StagedPermission = "manual" | "auto" | "yolo";

/** One project's unsent first message. Plain fields: the composer repaints them. */
export type SessionStage = {
  draft: string;
  pictures: DraftPicture[];
  revision: number;
  /** Null until the person picks. The mint seed stays on the daemon. */
  model: ModelChoice | null;
  /** Empty is the ordinary session. A name is a bot face adopted at mint. */
  agent: string;
  /** Null until the person picks. A pick is not the kernel default. */
  permission: StagedPermission | null;
  sending: boolean;
  status: string;
};

type PendingSession = {
  readonly prompt: string;
  readonly pictures: readonly DraftPicture[];
  readonly model: ModelChoice | null;
  readonly agent: string;
  readonly permission: StagedPermission | null;
};

export type AgentFace = {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: unknown;
  readonly recipeScope?: unknown;
  readonly keepAlive?: boolean;
  readonly reasoningEffort?: unknown;
  readonly behaviorJson?: string | null;
  readonly error?: string | null;
};

export type StagedAgent = {
  readonly name: string;
  readonly face: AgentFace;
};

type StagedSpec = {
  readonly name: string;
  adoptNamedRecipe?(bot: {
    readonly name: string;
    readonly recipeScope: RecipeScope;
    readonly keepAlive: boolean;
    readonly description: string;
    readonly instructions: SystemPrompt;
    readonly reasoningEffort: ReasoningEffort | null;
    readonly behaviorPinJson: string | null;
  }): void;
};

type AdmitResult = { readonly ok: true; readonly status: string } | { readonly ok: false; readonly status: string };

const stages = new Map<string, SessionStage>();
const pending = new Map<string, PendingSession>();
const focusListeners = new Set<() => void>();

export function stageOf(path: string): SessionStage {
  let stage = stages.get(path);
  if (stage == null) {
    stage = {
      draft: "",
      pictures: [],
      revision: 0,
      model: null,
      agent: "",
      permission: null,
      sending: false,
      status: "",
    };
    stages.set(path, stage);
  }
  return stage;
}

/** Project keys win, including an empty string, matching session mint. */
export function mintedModel(
  kernel: Readonly<Record<string, string>> | null | undefined,
  project: Readonly<Record<string, string>> | null | undefined,
): ModelChoice {
  const connection = own(project, "connection") ?? own(kernel, "connection") ?? "";
  const model = own(project, "model") ?? own(kernel, "model") ?? "";
  return { connection, model };
}

/** A missing key inherits. An empty string is a real value and wins. */
function own(record: Readonly<Record<string, string>> | null | undefined, key: string): string | null {
  if (record == null || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return typeof value === "string" ? value.trim() : null;
}

/** Kernel faces, then project faces. A project bot with the same name wins. Errored files stay out. */
export function stagedAgents(
  kernel: { readonly [name: string]: AgentFace | undefined } | null | undefined,
  project: { readonly [name: string]: AgentFace | undefined } | null | undefined,
): readonly StagedAgent[] {
  const byName = new Map<string, AgentFace>();
  const take = (bots: { readonly [name: string]: AgentFace | undefined } | null | undefined): void => {
    if (bots == null) return;
    for (const [key, bot] of Object.entries(bots)) {
      if (bot == null || (typeof bot.error === "string" && bot.error !== "")) continue;
      const named = typeof bot.name === "string" ? bot.name.trim() : "";
      const name = named === "" ? key.trim() : named;
      if (name === "") continue;
      byName.set(name, bot);
    }
  };
  take(kernel);
  take(project);
  return [...byName.entries()]
    .map(([name, face]) => ({ name, face }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function queueSession(id: string, payload: PendingSession): void {
  pending.set(id, {
    prompt: payload.prompt,
    pictures: payload.pictures.map(cloneDraftPicture),
    model: payload.model == null ? null : { connection: payload.model.connection, model: payload.model.model },
    agent: payload.agent,
    permission: payload.permission,
  });
}

export function peekSession(id: string): PendingSession | null {
  return pending.get(id) ?? null;
}

export function takeSession(id: string): PendingSession | null {
  const payload = pending.get(id) ?? null;
  if (payload != null) pending.delete(id);
  return payload;
}

export function dropSession(id: string): void {
  pending.delete(id);
}

export function focusStage(): void {
  for (const listener of focusListeners) listener();
}

export function subscribeStageFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

export function resetNewSessions(): void {
  stages.clear();
  pending.clear();
  focusListeners.clear();
}

/**
 * Apply the staged face, model, and permission, then admit the prompt.
 * A model write that fails does not start the turn. The caller keeps the draft.
 */
export async function admitStagedSession(
  spec: StagedSpec | null,
  rpc: { request: (method: string, params: unknown) => Promise<unknown> },
  payload: PendingSession,
  agents: readonly StagedAgent[],
): Promise<AdmitResult> {
  let status = "";
  if (payload.agent !== "") {
    const found = agents.find((row) => row.name === payload.agent);
    if (found == null || spec == null || spec.name !== "" || spec.adoptNamedRecipe == null) {
      status = "The agent was not applied.";
    } else {
      const nature = agentNatureOf(found.face.recipeScope);
      spec.adoptNamedRecipe({
        name: found.name,
        recipeScope: nature === "" ? "session" : nature,
        keepAlive: found.face.keepAlive === true,
        description: typeof found.face.description === "string" ? found.face.description : "",
        instructions: asSystemPrompt(typeof found.face.instructions === "string" ? found.face.instructions : ""),
        reasoningEffort: reasoningEffortOf(found.face.reasoningEffort),
        behaviorPinJson: typeof found.face.behaviorJson === "string" ? found.face.behaviorJson : null,
      });
    }
  }
  const choice = payload.model;
  if (choice != null) {
    const connectionResult = await rpc.request("kv/set", {
      key: "connection",
      value: choice.connection,
      remember: true,
    });
    if (!isOk(connectionResult)) return { ok: false, status: "Model was not changed." };
    const modelResult = await rpc.request("kv/set", { key: "model", value: choice.model, remember: true });
    if (!isOk(modelResult)) return { ok: false, status: "Connection changed, but the model was not." };
  }
  if (payload.permission != null) {
    const policyResult = await rpc.request("policy/set", { policy: payload.permission });
    if (!isOk(policyResult)) status = "Permission mode was not changed.";
  }
  const visuals = turnVisualPayload(payload.pictures);
  const turnResult = await rpc.request(
    "turn",
    visuals.length === 0 ? { prompt: payload.prompt } : { prompt: payload.prompt, visuals },
  );
  if (!isOk(turnResult)) return { ok: false, status: "Message was not accepted. Your draft is saved." };
  return { ok: true, status };
}

function isOk(result: unknown): boolean {
  return typeof result === "object" && result != null && "ok" in result && result.ok === true;
}
