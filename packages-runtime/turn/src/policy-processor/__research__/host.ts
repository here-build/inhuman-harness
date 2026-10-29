/**
 * Local LM Studio PEW host for remainder-classifier research.
 * Not imported by `pnpm test`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Plexus, resetLocalIDs } from "@here.build/plexus";
import {
  CompletionExpectation,
  KernelPlexus,
  KernelRoot,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  ToolCallJob,
  type TurnChunk,
} from "@inhuman.tools/harness-model";
import { reasonableDefaultsSource } from "@inhuman.tools/policy/floor";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import type { DriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";
import { Orchestrator } from "@inhuman.tools/plexus-expectations/executor";
import { configure, when } from "mobx";

configure({ enforceActions: "never" });

import { completedAssistant, sealedObservation } from "../__tests__/_helpers/jobs.js";
import { license } from "../license.js";
import { scopes } from "../scope.js";

import { OpenAiCompatDriverConnection } from "@/providers/openai-compat";

export const LM_BASE = "http://127.0.0.1:1234/v1";
export const LM_MODEL = "essentialai_rnj-1-instruct@q4_k_s";
export const LM_CONNECTION = "lmstudio";

const here = dirname(fileURLToPath(import.meta.url));

export function distAskSource(): string {
  return readFileSync(join(here, "../../../policy/auto-mode-ask.scm"), "utf8");
}

export async function lmStudioReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const native = await fetch("http://127.0.0.1:1234/api/v0/models", { signal: AbortSignal.timeout(2000) });
    if (native.ok) {
      const body = (await native.json()) as { data?: Array<{ id?: string; state?: string }> };
      const row = (body.data ?? []).find((item) => item.id === LM_MODEL);
      if (row === undefined) return { ok: false, reason: `${LM_MODEL} not in catalog` };
      if (row.state !== undefined && row.state !== "loaded") {
        return { ok: false, reason: `${LM_MODEL} state=${row.state}` };
      }
      return { ok: true };
    }
    const res = await fetch(`${LM_BASE}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, reason: `GET /models ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((row) => row.id);
    if (!ids.includes(LM_MODEL)) return { ok: false, reason: `${LM_MODEL} not in catalog` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Force the request `model` even if connection YAML dropped it. */
class ResearchDriver extends OpenAiCompatDriverConnection {
  constructor(connectionId: string, settings: unknown = {}, secrets?: unknown) {
    const bag = settings !== null && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
    super(connectionId, { ...bag, model: LM_MODEL, temperature: 0 }, secrets as never);
  }
}

class ResearchOrchestrator extends Orchestrator {
  override async loadDriverModule(): Promise<DriverConnectionClass> {
    return ResearchDriver as unknown as DriverConnectionClass;
  }
}

export function researchSetup(opts?: {
  readonly privileged?: string;
  readonly priorTurn?: string;
  readonly quarantined?: string;
}): {
  readonly root: SessionRoot;
  readonly turn: SessionTurn;
  readonly host: ResearchOrchestrator;
  enqueue(job: ToolCallJob): void;
  [Symbol.dispose](): void;
} {
  resetLocalIDs();
  const kernel = KernelPlexus.bootstrap(new KernelRoot());
  const driver = new DriverSpec({
    name: "openai-compat",
    description: "lm studio",
    abilityClaim: ["completion"],
    importPath: "research:openai-compat",
  });
  kernel.root.drivers = { "openai-compat": driver };
  const spec = new ConnectionSpec({ driver, name: LM_CONNECTION });
  spec.configuration = { baseUrl: LM_BASE, model: LM_MODEL, temperature: 0 };
  kernel.root.connections = { [LM_CONNECTION]: spec };

  const root = new SessionRoot({
    sessionId: "s-research",
    path: "/tmp/research",
    standingPermissionMode: "auto",
    policyProgram: reasonableDefaultsSource,
    judgeAskProgram: distAskSource(),
  });
  const session = Plexus.bootstrap(root);
  root.applyKvs([
    { form: "kv-set", key: "connection", value: LM_CONNECTION },
    { form: "kv-set", key: "model", value: LM_MODEL },
    { form: "kv-set", key: "judgeConnection", value: LM_CONNECTION },
    { form: "kv-set", key: "judgeModel", value: LM_MODEL },
  ]);
  const doneWork: TurnChunk[] = [];
  if (opts?.priorTurn !== undefined && opts.priorTurn !== "") doneWork.push(completedAssistant(opts.priorTurn));
  if (opts?.quarantined !== undefined && opts.quarantined !== "") doneWork.push(sealedObservation(opts.quarantined));
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: opts?.privileged ?? "",
    queue: [],
    doneWork,
  });
  root.head = turn;
  const scope = scopes.get(root);
  scope.backoffMs = () => 60_000;
  const host = new ResearchOrchestrator(kernel, session);
  host.registerExecutor(
    ToolCallJob,
    (job) => license(job, turn, root),
    async () => {},
  );
  host.activate();
  return {
    root,
    turn,
    host,
    enqueue(job) {
      turn.enqueue(job);
    },
    [Symbol.dispose]() {
      host[Symbol.dispose]();
      scope.close();
      kernel.destroy();
      session.destroy();
    },
  };
}

function childDump(job: ToolCallJob): unknown {
  return (job.children as unknown[]).map((child) => {
    if (child instanceof CompletionExpectation) {
      return {
        model: child.model,
        connectionId: child.connectionId,
        outcome: child.outcome,
        fail: child.failReason,
      };
    }
    return { kind: typeof child };
  });
}

export async function untilJudged(job: ToolCallJob, timeout = 90_000): Promise<void> {
  try {
    await when(() => job.classifierResult !== null || job.orchestrated || job.classifierAbstain !== null, { timeout });
  } catch (error) {
    throw new Error(
      `untilJudged: policy=${job.policyResult} judge=${job.classifierResult} fail=${job.classifierAbstain} children=${JSON.stringify(childDump(job))}`,
      { cause: error },
    );
  }
}
