/**
 * Control-plane glance for one session.
 *
 * Title is a projection of `SessionRoot.title`. `status` is
 * `SessionRoot.turnDescription`. `lastMessageAt` is last turn
 * admit or steer — not attach, not rename, not metadata, not liveness.
 * Kernel is a lens: the daemon writes this row. Clients do not intern the
 * worker document; they read this row. Resume / continue list conversations
 * only (`isConversationOverview`). Named workers and one-shots stay on the
 * map so the caller tape can dim live status and `Client.agents` can
 * project state without attaching.
 */
import { Model, model, state } from "@inhuman.tools/model";

import { agentNatureOf, type AgentNature } from "../recipe-scope.js";
import type { KernelRoot } from "./KernelRoot.js";
import type { SessionOverviewFace } from "../shared/session-overview.js";
import type { SessionUnfinished } from "../shared/session-unfinished.js";

export type { SessionOverviewFace } from "../shared/session-overview.js";

@model("harness:kernel:session-overview")
export class SessionOverview extends Model<any, KernelRoot | null> {
  get sessionId(): string {
    return (this.parentFieldKey as string | null) ?? "";
  }

  @state accessor title: string = "";
  /** Unix ms. Null until the intern stamps it. */
  @state accessor lastMessageAt: number | null = null;
  /** Recipe scope. Empty = conversation or one-shot. Resume skips non-empty. */
  @state accessor recipeScope: AgentNature = "";
  /** Snapshotted `Agent.spec.name`. Empty on a conversation / anonymous ask. */
  @state accessor specName: string = "";
  /** Snapshotted `Agent.spec.resident`. Occupancy park skips this row. */
  @state accessor resident: boolean = false;
  /** Snapshotted `Agent.spec.keepAlive`. */
  @state accessor keepAlive: boolean = false;
  /** `spec instanceof AskAgentSpec`. Resume skips. Not a recipe scope. */
  @state accessor oneShot: boolean = false;
  /** Worker `kvs.model`. Empty until inherited / set. */
  @state accessor model: string = "";
  /** `SessionRoot.turnDescription`. Empty until `update_metadata` writes one. */
  @state accessor status: string = "";
  /** Worker `SessionRoot.isMidMotion()`. Not recency. */
  @state accessor midMotion: boolean = false;
  /** Snapshotted `SessionRoot.openTurn`. Head turn still open. */
  @state accessor openTurn: boolean = false;
  /** Snapshotted `SessionRoot.openToolCount`. Unsealed tool calls. */
  @state accessor openToolCount: number = 0;
  /** Snapshotted `SessionRoot.periodArmed`. `scheme_watch` idle deadline. */
  @state accessor periodArmed: boolean = false;
  /** Open `agentCallbacks` rows on the worker. */
  @state accessor openCallbackCount: number = 0;
  /** Sitting ask on the running turn. `SessionRoot.asking`. */
  @state accessor asking: boolean = false;
  /** Snapshotted `SessionRoot.unfinished`. Ask > tools > turn. Empty = none. */
  @state accessor unfinished: SessionUnfinished = "";
  /** Latest interactive user prompt. Flattened. Empty until a turn has `prompt`. */
  @state accessor lastPrompt: string = "";
  /**
   * Sitting-ask question line. Empty unless `unfinished === "ask"`.
   * Listing TUI paints this verbatim.
   */
  @state accessor askLine: string = "";
  /**
   * Speech-question pin. Empty unless `unfinished === "question"`.
   * Not license `askLine`.
   */
  @state accessor questionLine: string = "";

  constructor(
    opts?:
      | {
          readonly title?: string;
          readonly lastMessageAt?: number | null;
          readonly recipeScope?: AgentNature;
          readonly specName?: string;
          readonly resident?: boolean;
          readonly keepAlive?: boolean;
          readonly oneShot?: boolean;
          readonly model?: string;
          readonly status?: string;
          readonly midMotion?: boolean;
          readonly openTurn?: boolean;
          readonly openToolCount?: number;
          readonly periodArmed?: boolean;
          readonly openCallbackCount?: number;
          readonly asking?: boolean;
          readonly unfinished?: SessionUnfinished;
          readonly lastPrompt?: string;
          readonly askLine?: string;
          readonly questionLine?: string;
        }
      | symbol,
  ) {
    super(opts);
  }
}

/**
 * Documents written before the thesaurus rename. The XmlElement name stays
 * `harness:kernel:session-glance`. `scope`, `daemon`, and `blocked` are the
 * previous field names; {@link hydrateSessionOverview} copies each once.
 */
@model("harness:kernel:session-glance")
export class SessionGlance extends SessionOverview {
  @state accessor scope: string = "";
  @state accessor daemon: boolean = false;
  @state accessor blocked: boolean = false;
}

export function hydrateSessionOverview(row: SessionOverview): void {
  if (!(row instanceof SessionGlance)) return;
  if (row.scope !== "") {
    if (row.recipeScope === "") row.recipeScope = agentNatureOf(row.scope);
    row.scope = "";
  }
  if (row.daemon) {
    if (!row.resident) row.resident = true;
    row.daemon = false;
  }
  if (row.blocked) {
    if (!row.asking) row.asking = true;
    row.blocked = false;
  }
}

export function writeOverviewFace(row: SessionOverview, snap: SessionOverviewFace): void {
  if (row.title !== snap.title) row.title = snap.title;
  if (row.recipeScope !== snap.recipeScope) row.recipeScope = snap.recipeScope;
  if (row.specName !== snap.specName) row.specName = snap.specName;
  if (row.resident !== snap.resident) row.resident = snap.resident;
  if (row.keepAlive !== snap.keepAlive) row.keepAlive = snap.keepAlive;
  if (row.oneShot !== snap.oneShot) row.oneShot = snap.oneShot;
  if (row.model !== snap.model) row.model = snap.model;
  if (row.status !== snap.status) row.status = snap.status;
  if (row.midMotion !== snap.midMotion) row.midMotion = snap.midMotion;
  if (row.openTurn !== snap.openTurn) row.openTurn = snap.openTurn;
  if (row.openToolCount !== snap.openToolCount) row.openToolCount = snap.openToolCount;
  if (row.periodArmed !== snap.periodArmed) row.periodArmed = snap.periodArmed;
  if (row.openCallbackCount !== snap.openCallbackCount) row.openCallbackCount = snap.openCallbackCount;
  if (row.asking !== snap.asking) row.asking = snap.asking;
  if (row.unfinished !== snap.unfinished) row.unfinished = snap.unfinished;
  if (row.lastPrompt !== snap.lastPrompt) row.lastPrompt = snap.lastPrompt;
  if (row.askLine !== snap.askLine) row.askLine = snap.askLine;
  if (row.questionLine !== snap.questionLine) row.questionLine = snap.questionLine;
}

/** Empty recipe scope and not a one-shot. Missing `oneShot` is a conversation. */
export function isConversationOverview(
  glance: { readonly recipeScope?: string; readonly oneShot?: boolean } | null | undefined,
): boolean {
  return glance != null && (glance.recipeScope ?? "") === "" && glance.oneShot !== true;
}
