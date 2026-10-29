/**
 * Host surfaces this package observes. Kernel/project/harness daemons stay
 * outside; composition supplies commands and park abort through these.
 */
import type { UserPrompt } from "@inhuman.tools/harness-commons";
import type {
  CompletionExpectation,
  RegisteredToolsSet,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SkillSpec,
} from "@inhuman.tools/harness-model";
import type { Job, WorkExpectation } from "@inhuman.tools/plexus-expectations";

export type SessionCommandHost = {
  readonly session: SessionRoot;
  readonly constitution: string;
  env(): Record<string, string>;
  toolsFor(tail: SessionSystemPrompt | SessionTurn | null): RegisteredToolsSet | null;
  queuedVerbs(): ReadonlySet<string>;
  /** R1: the resolved context-retention policy JSON a new turn is stamped with. Omit = unstamped (legacy). */
  retentionJson?(): string;
  /**
   * Skill slash split. `prompt` stays what was typed. `derived` is the model
   * injection when it differs, otherwise null.
   */
  expandSkill?(
    prompt: UserPrompt,
    skills: readonly SkillSpec[],
    verbs: ReadonlySet<string>,
  ): { readonly prompt: UserPrompt; readonly derived: UserPrompt | null };
  syncSkills?(): void;
  applyBotNotice?(turn: SessionTurn): void;
  restorePluginState?(): void;
  cancelOwned(turn: SessionTurn): void;
  skipBackoff?(completion: CompletionExpectation): void;
  loadTurn?(id: string): SessionTurn | undefined;
  rename?(title: string): { readonly ok: true; readonly title: string };
  log?(message: string): void;
  /** `compactKeepTurns` dial, recorded on a `/compact` job when it is minted (F8). */
  compactKeepTurns?(): number;
  readonly closed?: boolean;
};

export type ParkWork = {
  abortJob(job: Job, reason?: unknown): void;
  inFlightJobs(): Iterable<Job>;
  abortExpectation?(expectation: WorkExpectation, reason?: unknown): void;
};
