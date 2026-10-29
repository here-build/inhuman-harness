import { FieldAwareness, syncing } from "@here.build/plexus";
import { docPlexus } from "@here.build/plexus/internals";
import { prompt, type UserPrompt } from "@inhuman.tools/harness-commons";
import { STATUSLINE_LANE, walkWork, WorkContainer } from "@inhuman.tools/plexus-expectations";
import { comparer, computed, observable, type IObservableValue } from "mobx";

import { Agent, type OpenAgentCallback } from "./Agent.js";
import { pendingResultNotes } from "./background-jobs.js";
import { documentRoot } from "./document-root.js";
import type { PermissionMode } from "./eval-context.js";
import { AgentCallNotification } from "./jobs/AgentCallNotification.js";
import { mcpToolRefKey, type McpPersistScope } from "./mcp-name-floor.js";
import { projectionsOf } from "./projection-registry.js";
import { SkillSpec } from "./prompt-parts.js";
import { readRootOf } from "./read-roots.js";
import { type SessionUnfinished } from "./unfinished.js";
import { ActionSpec } from "../shared/ActionSpec.js";
import { applyKv } from "../shared/KeyValueStorage.js";
import type { KvProposal } from "../shared/residual.js";
import { parseGrantRows } from "./authorization/grants.js";
import { CallJob } from "./jobs/CallJob.js";
import { CompactJob } from "./jobs/CompactJob.js";
import { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import { ToolCallJob } from "./jobs/ToolCallJob.js";
import { SessionAdmission } from "./SessionAdmission.js";
import { HARNESS_CONSTITUTION, SessionSystemPrompt } from "./SessionSystemPrompt.js";
import { EMPTY_STORAGE, storageAfterTurn, type PluginStorageMap } from "./trajectory-projection.js";
import {
  reactChunks,
  ReACTChunk,
  SessionTurn,
  TurnNotificationChunk,
  TurnPromptChunk,
  TurnSteerChunk,
  type SessionUnit,
} from "./turn/index.js";
import { sessionDisplayTitle } from "./update-metadata.js";

export { type SessionUnfinished } from "./unfinished.js";

/**
 * Desk permissions copied onto a delegated worker: the mode, the session read roots, the MCP persist
 * lists, the caller's session grants and the caller's authorization overlay (so a child is never
 * looser than the caller).
 */
export type PermissionSnap = {
  readonly policy: PermissionMode;
  readonly roots: Readonly<Record<string, string>>;
  readonly grantsJson: string;
  readonly overlayJson: string;
  readonly tools: Readonly<Record<string, McpPersistScope>>;
  readonly blocked: Readonly<Record<string, McpPersistScope>>;
};

const unhomedStatusline = new WeakMap<SessionRoot, IObservableValue<string>>();

function localStatusline(root: SessionRoot): IObservableValue<string> {
  let box = unhomedStatusline.get(root);
  if (box == null) {
    box = observable.box("");
    unhomedStatusline.set(root, box);
  }
  return box;
}

function statuslineLane(root: SessionRoot) {
  const doc = root.__doc__;
  const hub = doc == null ? null : docPlexus.get(doc)?.awareness;
  return hub == null ? null : new FieldAwareness(hub, STATUSLINE_LANE);
}

@syncing("harness:session:root")
export class SessionRoot extends WorkContainer {
  @syncing.record accessor kvs: Record<string, string> = {};

  @syncing.action
  applyKvs(proposals: readonly KvProposal[]): void {
    applyKv(this.kvs, proposals);
  }

  /**
   * `"connection"` → model this conversation last used on that wire. Mint
   * snapshots `{...kernel, ...project}`; later model selection writes here and
   * through to project/kernel. `/connect` reads this before the kernel record.
   */
  @syncing.record accessor lastUsedConnectionModel: Record<string, string> = {};

  @syncing.action
  stampLastUsedConnectionModel(connection: string, model: string): void {
    const conn = connection.trim();
    const mid = model.trim();
    if (conn === "" || mid === "") return;
    this.lastUsedConnectionModel[conn] = mid;
  }

  @syncing.action
  allowTool(connectionKey: string, serverToolName: string, scope: McpPersistScope): void {
    this.toolAllowlist[mcpToolRefKey(connectionKey, serverToolName)] = scope;
  }

  @syncing.action
  blockTool(connectionKey: string, serverToolName: string, scope: McpPersistScope): void {
    this.toolBlocklist[mcpToolRefKey(connectionKey, serverToolName)] = scope;
  }

  /**
   * "Treat <folder> as part of this session?" answered yes. The folder becomes a read root, so reads
   * under it follow the in-workspace rules. Returns false for a path that may not be a root.
   */
  @syncing.action
  addReadRoot(path: string): boolean {
    const root = readRootOf(this.path, path);
    if (root === undefined) return false;
    this.readRoots[root] = "session";
    return true;
  }

  /** Session-scope grant rows (JSON). A stored human "yes" to an ask; ends with the session. */
  @syncing.action
  replaceGrantsJson(json: string): void {
    this.grantsJson = json;
  }

  /** The human's overlay for this session. Set only through the human RPC. */
  @syncing.action
  replaceAuthorizationOverlay(json: string): void {
    this.authorizationOverlayJson = json;
  }

  /**
   * Worker-side: callback row plus inbound turn in one graph transaction. A
   * request with no reply (a message) seats the turn and opens no row.
   */
  @syncing.action
  enqueueAgentRequest(
    requestId: string,
    callerSessionId: string,
    userPrompt: UserPrompt,
    opts: { readonly callback?: boolean } = {},
  ): void {
    if (opts.callback !== false) this.agentCallbacks[requestId] = callerSessionId;
    if (this.findTurnByAgentRequestId(requestId) != null) return;
    const constitution = this.agent.spec.instructions || HARNESS_CONSTITUTION;
    const turn = new SessionTurn({
      turnTail: this.head ?? new SessionSystemPrompt({ constitution }),
      prompt: userPrompt,
      agentRequestId: requestId,
      inbound: true,
    });
    this.seatHead(turn);
  }

  /** A new turn becomes head and tip together, so no update lands it off its tip. */
  @syncing.action
  seatHead(turn: SessionTurn): void {
    this.head = turn;
    this.tip = turn;
  }

  /** Rewind: head moves to `turn` under `ceiling`; both inbox lists are abandoned with the future. */
  @syncing.action
  rewindHead(turn: SessionTurn, ceiling: SessionTurn | null): void {
    this.promptQueue.splice(0);
    this.steerQueue.splice(0);
    if (this.tip !== ceiling) this.tip = ceiling;
    this.head = turn;
  }

  @syncing.action
  removeAgentCallback(requestId: string): void {
    delete this.agentCallbacks[requestId];
  }

  @syncing.action
  ensureAgentCallback(requestId: string, callerSessionId: string): void {
    this.agentCallbacks[requestId] = callerSessionId;
  }

  @syncing accessor sessionId!: string;
  @syncing accessor path!: string;
  @syncing accessor mode: string = "act";
  /**
   * Standing tri-state, not a program id. Pre-head and first-turn attribute.
   * Live overlay is `head.permissionMode`. New sessions copy
   * `sessionMintPermissionMode` (project `defaultPermissionMode`, else kernel).
   */
  @syncing accessor standingPermissionMode: PermissionMode = "manual";
  /** Floor match body. Not a kernel path token. */
  @syncing accessor policyProgram: string = "";
  /** Auto residual ask processor body. */
  @syncing accessor judgeAskProgram: string = "";
  /**
   * Why this session's plugin behavior is not fully attached, or which of its
   * hooks failed this turn. Report only; never a vote.
   */
  @syncing accessor pluginProblem: string | null = null;
  /**
   * Each session-scoped plugin state owner's action log as JSON, keyed
   * `plugin:namespace`. It survives a park and a restart; a rewind replaces
   * it with the target turn's plugin state.
   */
  @syncing.record accessor pluginState: Record<string, string> = {};
  /** Leftover document record. Does not authorize. Empty on older documents. */
  @syncing.record accessor judgeCache: Record<string, string> = {};
  @syncing.child.record accessor actions: Record<string, ActionSpec> = {};
  @syncing.child.list accessor skills: SkillSpec[] = [];
  /**
   * Live-turn inbox. Claimed at Prompt/ReACT. Not `.work`.
   * Kind is which list, not a timing enum.
   */
  @syncing.child.list accessor steerQueue: SessionAdmission[] = [];
  /** Next-turn inbox. Claimed when the head is closed. Not `.work`. */
  @syncing.child.list accessor promptQueue: SessionAdmission[] = [];
  @syncing.child accessor agent: Agent = new Agent();
  /** Session-scope roster: recipe name → bot `sessionId`. Several names may share one id (rename). */
  @syncing.record accessor botsRoster: Record<string, string> = {};
  /** Open Call obligations: `CallJob.uuid` → caller `sessionId`. */
  @syncing.record accessor agentCallbacks: Record<string, string> = {};
  /** Request ids cancelled before or after admission. Empty on older documents. */
  @syncing.record accessor cancelledEvalRequests: Record<string, "1"> = {};
  /**
   * Session-remembered MCP look-ups. Key is `connection:serverToolName`.
   * Value is `session` or `always`. Always also lands on connection
   * `alwaysAllow`. Not a license without the read floor.
   */
  @syncing.record accessor toolAllowlist: Record<string, McpPersistScope> = {};
  /**
   * Session-hidden MCP names. Same key. Hide + deny this session.
   * `always` also appends `!name` to connection `tools`. Not a silent
   * ask→deny while the name stays listed.
   */
  @syncing.record accessor toolBlocklist: Record<string, McpPersistScope> = {};
  /**
   * Session read roots: absolute folders the human said to treat as part of this session. Reads under
   * one follow the in-workspace rules; `block` rules still block. Not remembered across sessions.
   */
  @syncing.record accessor readRoots: Record<string, string> = {};
  /** Session-scope grant rows, JSON `GrantRow[]`. Daemon-only; a client does not write it. */
  @syncing accessor grantsJson: string = "";
  /** `config.json` `authorization`, the user layer. Daemon-stamped; a client does not write it. */
  @syncing accessor authorizationUserJson: string = "";
  /** `<repo>/.inhuman/authorization.json`, the project layer (tighten only). Daemon-stamped. */
  @syncing accessor authorizationProjectJson: string = "";
  /** The human's session overlay. Loosens only via human RPC, capped by the project layer. */
  @syncing accessor authorizationOverlayJson: string = "";
  /**
   * Operator-set session name. Empty means derive from tape
   * (`update_metadata`) or the first prompt. Survives rewind.
   */
  @syncing accessor manualTitle: string = "";
  /**
   * Last successful statusline left slot. Empty omits the left. Awareness
   * last-write, not a Yjs body: the round clock rewrites it on every tool
   * call. Unhomed roots (tests) keep it in-process.
   */
  get statuslineLeft(): string {
    const lane = statuslineLane(this);
    if (lane == null) return localStatusline(this).get();
    const own = lane.get();
    if (typeof own === "string") return own;
    for (const text of lane.getOthers().values()) {
      if (typeof text === "string" && text !== "") return text;
    }
    return "";
  }
  set statuslineLeft(text: string) {
    const lane = statuslineLane(this);
    if (lane == null) localStatusline(this).set(text);
    else if (text === "") lane.clear();
    else lane.set(text as never);
  }
  constructor(
    props?:
      | {
          readonly sessionId?: string;
          readonly path?: string;
          readonly mode?: string;
          readonly standingPermissionMode?: PermissionMode;
          readonly policyProgram?: string;
          readonly judgeAskProgram?: string;
          readonly judgeCache?: Record<string, string>;
          readonly lastUsedConnectionModel?: Record<string, string>;
          readonly actions?: Record<string, ActionSpec>;
          readonly skills?: SkillSpec[];
          readonly steerQueue?: SessionAdmission[];
          readonly promptQueue?: SessionAdmission[];
          readonly agent?: Agent;
          readonly botsRoster?: Record<string, string>;
          readonly agentCallbacks?: Record<string, string>;
          readonly cancelledEvalRequests?: Record<string, "1">;
          readonly toolAllowlist?: Record<string, McpPersistScope>;
          readonly toolBlocklist?: Record<string, McpPersistScope>;
          readonly readRoots?: Record<string, string>;
          readonly grantsJson?: string;
          readonly authorizationUserJson?: string;
          readonly authorizationProjectJson?: string;
          readonly authorizationOverlayJson?: string;
          readonly manualTitle?: string;
        }
      | symbol,
  ) {
    super(props);
    if (typeof props === "symbol") return;
    if (this.agent == null) this.agent = new Agent();
  }

  /** Alias for `agent.head`. Not a second synced field. */
  get head(): SessionTurn | null {
    return this.agent.head;
  }
  set head(turn: SessionTurn | null) {
    if (
      turn != null &&
      (turn.permissionMode == null || (turn.permissionMode as string) === "") &&
      !(turn.turnTail instanceof SessionTurn)
    ) {
      turn.permissionMode = this.standingPermissionMode;
    }
    this.agent.head = turn;
  }

  /** Alias for `agent.tip`. Not a second synced pointer. Rewind writes `head` only. */
  get tip(): SessionTurn | null {
    return this.agent.tip;
  }
  set tip(turn: SessionTurn | null) {
    this.agent.tip = turn;
  }

  /**
   * Chrome SSoT: live-head overlay, else standing. Assignment writes standing
   * and, when a head exists, the turn overlay.
   */
  @computed
  get permissionMode(): PermissionMode {
    return this.head?.effectivePermissionMode ?? this.standingPermissionMode;
  }
  set permissionMode(id: PermissionMode) {
    this.#assignCurrentPolicy(id);
  }

  @syncing.action
  #assignCurrentPolicy(id: PermissionMode): void {
    this.standingPermissionMode = id;
    if (this.head) this.head.permissionMode = id;
  }

  /** Session choice and the project's last-choice, one region. The config file stays with the caller. */
  @syncing.action
  writeChoicePermissionMode(policy: PermissionMode, project: { defaultPermissionMode: PermissionMode | "" }): void {
    this.permissionMode = policy;
    project.defaultPermissionMode = policy;
  }

  @syncing.action
  replaceSkills(
    rows: readonly {
      readonly name?: string;
      readonly description?: string;
      readonly location?: string;
      readonly invoke?: string;
    }[],
  ): void {
    this.skills.splice(0);
    for (const row of rows) this.skills.push(new SkillSpec(row));
  }

  /** A child takes the caller's mode, roots, session grants and overlay: never looser than the caller. */
  @syncing.action
  applyPermissionSnap(snap: PermissionSnap): void {
    this.permissionMode = snap.policy;
    // The caller's session grants become this session's own: same ids, so a revoke on the desk follows.
    const inherited = parseGrantRows(snap.grantsJson).map((row) =>
      row.scope === "session" ? { ...row, scopeKey: this.sessionId } : row,
    );
    this.grantsJson = inherited.length === 0 ? "" : JSON.stringify(inherited);
    this.authorizationOverlayJson = snap.overlayJson;
    replaceStringRecord(this.readRoots, snap.roots);
    replaceStringRecord(this.toolAllowlist, snap.tools);
    replaceStringRecord(this.toolBlocklist, snap.blocked);
  }

  /** Resume-list one-liner. Manual rename outranks tape; tape outranks first-prompt fallback. */
  @computed
  get title(): string {
    return sessionDisplayTitle(this);
  }

  /** Latest turn recap from `update_metadata`. Empty when none. */
  @computed
  get turnDescription(): string {
    return this.head?.metadata?.description ?? "";
  }

  /** Head projection. Empty session is the empty map. */
  @computed.struct
  get storageAfter(): PluginStorageMap {
    return this.head instanceof SessionTurn ? storageAfterTurn(this.head, projectionsOf(this)) : EMPTY_STORAGE;
  }

  /**
   * Head, inbound predecessors, then other unclosed liveTurns.
   * COLLECTORS ARE NOT `.work`. The Turn node is a direct item so
   * `registerExecutor(SessionTurn)` claims it. Tape is not work.
   * An interactive overlay must not drop a sitting unattended eval that
   * is still in the tail chain.
   */
  @computed
  get work(): WorkContainer[] {
    const work: WorkContainer[] = [...this.liveChain];
    for (const turn of this.liveTurns) {
      if (work.includes(turn)) continue;
      if (!turn.reducerExited) {
        work.push(turn);
        continue;
      }
      for (const node of turn.openBackgroundWork) {
        work.push(node);
      }
    }
    return work;
  }

  /**
   * Head, then each inbound predecessor it waits on. An inbound turn starts
   * when its tail's reducer exits. Cycle-safe.
   */
  @computed({ equals: comparer.shallow })
  get liveChain(): readonly SessionTurn[] {
    const chain: SessionTurn[] = [];
    let unit = this.head;
    while (unit != null && !chain.includes(unit)) {
      chain.push(unit);
      unit = unit.inbound && unit.turnTail instanceof SessionTurn ? unit.turnTail : null;
    }
    return chain;
  }

  /** The turn the executor is in: the oldest open turn on `liveChain`. */
  findRunningTurn(): SessionTurn | null {
    return this.liveChain.findLast((turn) => turn.inLoop) ?? null;
  }

  /**
   * The running turn when it takes a steer. Not an eval, not cancelled, and
   * not compact-only: compact with no prompt and no ReACT.
   */
  @computed
  get steerTurn(): SessionTurn | null {
    const turn = this.findRunningTurn();
    if (turn == null || turn.cancelRequested || turn.cancelled || turn.evalSpec != null) return null;
    const chunks = reactChunks(turn);
    const compactOnly =
      chunks.some((chunk) => chunk instanceof CompactJob) &&
      !chunks.some((chunk) => chunk instanceof TurnPromptChunk || chunk instanceof ReACTChunk);
    return compactOnly ? null : turn;
  }

  /** The running turn's tape still has a live completion, tool, or scheme. */
  @computed
  get openWork(): boolean {
    return this.findRunningTurn()?.openWork === true;
  }

  /** The running turn still has a loop token after the last completion. */
  @computed
  get queuedContinuation(): boolean {
    return this.findRunningTurn()?.queuedContinuation === true;
  }

  /** No running turn, or it is cancelling — live chrome must drop. */
  @computed
  get cutOff(): boolean {
    const turn = this.findRunningTurn();
    return this.head != null && (turn == null || turn.cutOff);
  }

  /** The running turn is an unattended eval. */
  @computed
  get unattended(): boolean {
    return this.findRunningTurn()?.unattended === true;
  }

  /**
   * Closed interactive head that did not true-finish. Idle empty Enter
   * mints a successor. Not `openTurn`.
   */
  @computed
  get lastTurnIncomplete(): boolean {
    return this.head instanceof SessionTurn && this.head.lastTurnIncomplete;
  }

  /** Head chain and liveTurns, including closed inbound history. */
  findTurnByAgentRequestId(requestId: string): SessionTurn | undefined {
    const seen = new Set<SessionTurn>();
    let unit: SessionUnit | null = this.head;
    while (unit instanceof SessionTurn) {
      if (seen.has(unit)) break;
      seen.add(unit);
      if (unit.agentRequestId === requestId) return unit;
      unit = unit.turnTail;
    }
    for (const turn of this.liveTurns) {
      if (turn.agentRequestId === requestId) return turn;
    }
    return undefined;
  }

  /**
   * Head work plus tail-ancestry children. `walkWork(root)` does not
   * descend `SessionTurn.turnTail`, so a sitting Call on a predecessor is
   * otherwise invisible to restart and reattach.
   */
  *motionWork(): Generator<WorkContainer> {
    const seen = new Set<WorkContainer>();
    for (const item of this.work) {
      if (!seen.has(item)) {
        seen.add(item);
        yield item;
      }
      const children = item instanceof SessionTurn ? item.subtreeWork : walkWork(item, seen);
      for (const node of children) {
        if (seen.has(node)) continue;
        seen.add(node);
        yield node;
      }
    }
    for (const turn of this.liveTurns) {
      for (const node of turn.subtreeWork) {
        if (seen.has(node)) continue;
        seen.add(node);
        yield node;
      }
    }
  }

  /** Incomplete Calls and bags that still grow a notify list. */
  @computed
  get incompleteNotifyingJobs(): Array<CallJob | ProgrammaticJob> {
    const jobs: Array<CallJob | ProgrammaticJob> = [];
    const seen = new Set<CallJob | ProgrammaticJob>();
    for (const node of this.motionWork()) {
      if (!(node instanceof CallJob || node instanceof ProgrammaticJob) || node.completed) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      jobs.push(node);
    }
    return jobs;
  }

  /**
   * Notes a `TurnNotificationChunk` on the live turn lineage packed. Rewind
   * past that cell re-pends them.
   */
  @computed
  get claimedNotifications(): ReadonlySet<AgentCallNotification> {
    const claimed = new Set<AgentCallNotification>();
    for (const turn of this.liveTurns) {
      for (const chunk of turn.notificationChunks) {
        for (const note of chunk.notifications) claimed.add(note);
      }
    }
    return claimed;
  }

  /** Origin atoms on incomplete jobs minus those already packed into a cell. */
  @computed
  get pendingNotifications(): AgentCallNotification[] {
    const claimed = this.claimedNotifications;
    const out: AgentCallNotification[] = [];
    for (const job of this.incompleteNotifyingJobs) {
      for (const note of job.notifications) {
        if (claimed.has(note) || note.message.trim() === "") continue;
        out.push(note);
      }
    }
    return out;
  }

  /** Terminal background jobs whose result cell is not on the tape yet. */
  @computed
  get pendingJobResults(): AgentCallNotification[] {
    return pendingResultNotes(this.motionWork(), this.claimedNotifications);
  }

  /** `pendingNotifications`, then the job results not already among them. The next notice cell packs these. */
  @computed({ equals: comparer.shallow })
  get pendingNotices(): readonly AgentCallNotification[] {
    const notices = [...this.pendingNotifications];
    for (const note of this.pendingJobResults) {
      if (!notices.includes(note)) notices.push(note);
    }
    return notices;
  }

  /** Sitting steers become cells on `turn` when it is `steerTurn`. One transaction with the inbox. */
  @syncing.action
  claimSteers(turn: SessionTurn): void {
    if (this.steerTurn !== turn) return;
    for (const row of this.steerQueue.splice(0)) {
      turn.doneWork.push(
        new TurnSteerChunk({
          text: row.text,
          derivedMessage: row.derivedMessage,
          composedAtMs: row.composedAtMs,
          composedAgainst: row.composedAgainst,
        }),
      );
    }
  }

  /** `pendingNotices` become one cell on `turn`. */
  @syncing.action
  claimNotices(turn: SessionTurn): void {
    const notifications = [...this.pendingNotices];
    if (notifications.length > 0) turn.doneWork.push(new TurnNotificationChunk({ notifications }));
  }

  /** A turn is still in the loop. Not `lastTurnIncomplete` (reducer left, empty Enter continues). */
  @computed
  get openTurn(): boolean {
    return this.findRunningTurn() != null;
  }

  /** Tool calls that have not sealed — sitting or claimed. */
  @computed
  get openToolCount(): number {
    let n = 0;
    for (const node of this.motionWork()) {
      if (node instanceof ToolCallJob && !node.completed) n += 1;
    }
    return n;
  }

  /** Sitting ask on the running turn. Same cut as glance `asking`. */
  @computed
  get asking(): boolean {
    return this.findRunningTurn()?.approvalHead != null;
  }

  /**
   * First hit wins: license ask, unsealed tool calls, an open turn, a
   * mid-tick bag, a speech-question pin. Idle `scheme_watch` is not
   * this — that is `periodArmed`. `question` is intern A `awaiting_user`,
   * not `needsHuman`.
   */
  @computed
  get unfinished(): SessionUnfinished {
    const head = this.head;
    const midTick = (): boolean => {
      for (const node of this.motionWork()) {
        if (node instanceof ProgrammaticJob && !node.completed && node.periodWaitUntilMs == null) return true;
      }
      return false;
    };
    switch (true) {
      case this.asking:
        return "ask";
      case this.openToolCount > 0:
        return "tools";
      case this.openTurn:
        return "turn";
      case midTick():
        return "tools";
      case head instanceof SessionTurn && typeof head.questionLine === "string" && head.questionLine.trim() !== "":
        return "question";
      default:
        return "";
    }
  }

  /** `scheme_watch` idle deadline is set. Mid-tick is `periodWaitUntilMs == null`. */
  @computed
  get periodArmed(): boolean {
    for (const node of this.motionWork()) {
      if (node instanceof ProgrammaticJob && !node.completed && node.periodWaitUntilMs != null) return true;
    }
    return false;
  }

  /**
   * Derived mid-motion: open turn, unsealed tool, or incomplete program.
   * Not a stored bit — restart reads this, it cannot drift from the loop.
   */
  @computed
  get midMotion(): boolean {
    if (this.openTurn || this.openToolCount > 0) return true;
    for (const node of this.motionWork()) {
      if (node instanceof ProgrammaticJob && !node.completed) return true;
    }
    return false;
  }

  isMidMotion(): boolean {
    return this.midMotion;
  }

  @computed
  get openCallbackCount(): number {
    return Object.keys(this.agentCallbacks).length;
  }

  /** Live `agentCallbacks` keys with the inbound prompt, stable order. */
  openCallbackRows(): OpenAgentCallback[] {
    return Object.keys(this.agentCallbacks)
      .sort()
      .map((requestId) => ({
        requestId,
        prompt: this.findTurnByAgentRequestId(requestId)?.prompt ?? prompt.user``,
      }));
  }

  /** Head's tail-ancestry, identity set. Cycle-safe. Base: tail is not a SessionTurn. */
  @computed
  get liveTurns(): ReadonlySet<SessionTurn> {
    const live = new Set<SessionTurn>();
    let unit: SessionUnit | null = this.head;
    while (unit instanceof SessionTurn) {
      if (live.has(unit)) break;
      live.add(unit);
      unit = unit.turnTail;
    }
    return live;
  }
}

/** A live notice cell in the note's own session packed it. An unhomed note is unclaimed. */
export function isNoteClaimed(note: AgentCallNotification): boolean {
  const root = documentRoot(note);
  return root instanceof SessionRoot && root.claimedNotifications.has(note);
}

function replaceStringRecord<V extends string>(into: Record<string, V>, from: Readonly<Record<string, V>>): void {
  for (const key of Object.keys(into)) {
    if (from[key] === undefined) delete into[key];
  }
  for (const [key, value] of Object.entries(from)) {
    if (into[key] !== value) into[key] = value;
  }
}

/** Leftover session images omit later `@syncing` fields. Constructor hydrate does not survive `connect` bind. */
export function hydrateSessionRoot(root: SessionRoot): void {
  root.agent.reownHead();
  const seen = new Set<SessionTurn>();
  const visit = (unit: SessionUnit | null): void => {
    let cell = unit;
    while (cell instanceof SessionTurn && !seen.has(cell)) {
      seen.add(cell);
      if (typeof cell.questionLine !== "string") cell.questionLine = "";
      cell = cell.turnTail;
    }
  };
  visit(root.head);
  visit(root.tip);
}
