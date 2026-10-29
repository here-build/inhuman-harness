/**
 * Compact-strategy transcript: an ordered eat slice plus the cap that rides it.
 *
 * Cells are completions, tool calls, card/ack message chunks, or text cells.
 *
 * THE WALK: `walkTranscript` is the only eat iteration. A cutoff
 * (`CompactJob`) projects the retained context; a completion anchors a round; tools and scheme
 * programs attach to the open completion. Notification cells, approval notes,
 * and steers collect parallel to tools — they never anchor or break a round.
 * Inner scheme invocations
 * live on `ProgrammaticJob` children, not this walk. `messagesFrom` and
 * `Transcript.fromWork` walk it. Remaining eat cells
 * (`MessageChunk`, text cell) yield `cell` so `fromWork` stays a walk —
 * the last-eat and rounds views ignore them. A new chunk kind is a union
 * member plus per-view handling. An uncommitted compact, prompt, ReACT, and
 * non-eat values are silent.
 *
 * Rounds here group the materialized cell list so cutoff card cells
 * can themselves be rounds. A successful `CompactJob` replaces the prefix and
 * marks its `card` cells as prior cards
 * (`transcript/compaction-results`). Cells before the first round anchor
 * (prior cards) belong to the oldest slice: `sliceRounds(0, …)` starts at
 * cell 0, so prefix ∪ keep = full.
 *
 * Occupancy: a stamped `totalTokens` is `usage.total_tokens` of that call —
 * prompt + response, where the prompt carries the whole history. It is a
 * monotone window GAUGE, not a per-cell weight; summing it across completions
 * over-counts quadratically. `tokensUsed()` therefore diffs the gauge at the
 * slice boundary (`baseGauge` = last reading before the slice) and falls back
 * to `contentTokensOf` (ceil chars/4) for cells past the last reading.
 * `contentTokensOf` is the raw content meter (`tokens/count`).
 *
 * There is no card-kind field on `CompletionExpectation`; card identity is the
 * card set (plus `MessageChunk.card`). That is the hook the models
 * give us today.
 */
import { arrival } from "@here.build/arrival/host-internals";
import {
  CompactJob,
  CompletionExpectation,
  type CompletionMessage,
  type ContextNeed,
  contextNeedFromChunks,
  DEFAULT_COMPACT_KEEP_TURNS as COMPACT_KEEP_DIAL,
  jobTriggersReactLoop,
  ProgrammaticJob,
  SessionRoot,
  SessionTurn,
  tapeCompletion,
  ToolCallJob,
  type TurnChunk,
  TurnApprovalNoteChunk,
  TurnNotificationChunk,
  TurnSteerChunk,
} from "@inhuman.tools/harness-model";

import { keepFloorsOfJob } from "./compact-floors.js";
import { compactToolLine, toolCallRepresentation } from "./squeeze.js";

export type MessageRole = "user" | "assistant";

export class MessageChunk {
  readonly role: MessageRole;
  readonly text: string;
  readonly ack: boolean;
  readonly checkIn: boolean;

  constructor(role: MessageRole, text: string, flags?: { readonly ack?: boolean; readonly checkIn?: boolean }) {
    this.role = role;
    this.text = text;
    this.ack = flags?.ack === true;
    this.checkIn = flags?.checkIn === true;
  }

  asCheckIn(): MessageChunk {
    return this.checkIn ? this : new MessageChunk(this.role, this.text, { ack: this.ack, checkIn: true });
  }
}

export type EatCell = CompletionMessage | MessageChunk;

export type TranscriptEvent =
  | { readonly kind: "compact"; readonly chunk: CompactJob }
  | { readonly kind: "completion"; readonly chunk: CompletionExpectation }
  | { readonly kind: "tool"; readonly chunk: ToolCallJob }
  | { readonly kind: "scheme"; readonly chunk: ProgrammaticJob }
  | { readonly kind: "notify"; readonly chunk: TurnNotificationChunk }
  | { readonly kind: "steer"; readonly chunk: TurnSteerChunk }
  | { readonly kind: "approval-note"; readonly chunk: TurnApprovalNoteChunk }
  | { readonly kind: "cell"; readonly chunk: MessageChunk | string };

export function turnSpine(turn: SessionTurn): TurnChunk[] {
  return [...turn.doneWork, ...turn.queue];
}

export type CompactRead = {
  /** `compactKeepTurns` dial. A stamped CompactJob keeps its own reading. */
  readonly configFloor?: number;
  readonly kv?: Readonly<Record<string, string>>;
};

/** Compact-dropped `read_file` jobs are not in this projection (compact policy). */
export function historyBehind(turn: SessionTurn, read?: CompactRead): CompletionMessage[] {
  const ctx = historyRead(turn, read);
  const own = messagesFrom(turnSpine(turn), ctx, () =>
    turn.turnTail instanceof SessionTurn ? historyBehind(turn.turnTail, read) : [],
  );
  return finishHistory(own, () => (turn.turnTail instanceof SessionTurn ? historyBehind(turn.turnTail, read) : []));
}

/** Eat a successful compact saw: history strictly before the job, tail included. */
export function eatBeforeCompact(turn: SessionTurn, job: CompactJob, read?: CompactRead): CompletionMessage[] {
  const ctx = historyRead(turn, read);
  const own = messagesFrom(
    turnSpine(turn),
    ctx,
    () => (turn.turnTail instanceof SessionTurn ? historyBehind(turn.turnTail, read) : []),
    job,
  );
  return finishHistory(own, () => (turn.turnTail instanceof SessionTurn ? historyBehind(turn.turnTail, read) : []));
}

function finishHistory(own: HistorySlice, tail: () => CompletionMessage[]): CompletionMessage[] {
  if (own.anchored) return own.messages;
  if (own.replaced || own.messages.length > 0) return [...own.messages, ...own.pending];
  return [...tail(), ...own.pending];
}

type HistoryRead = {
  readonly tailNeed: ContextNeed | null;
  readonly kv: Readonly<Record<string, string>>;
  readonly configFloor: number;
};

function historyRead(turn: SessionTurn, read: CompactRead | undefined): HistoryRead {
  return {
    tailNeed: turn.turnTail instanceof SessionTurn ? turn.turnTail.contextNeed : null,
    kv: read?.kv ?? sessionKv(turn),
    configFloor: read?.configFloor != null && read.configFloor >= 1 ? read.configFloor : COMPACT_KEEP_DIAL,
  };
}

function sessionKv(turn: SessionTurn): Readonly<Record<string, string>> {
  const parent = turn.parent;
  if (parent instanceof SessionRoot) return parent.kvs;
  return {};
}

type HistorySlice = {
  readonly messages: CompletionMessage[];
  readonly anchored: boolean;
  readonly replaced: boolean;
  readonly pending: Array<TurnNotificationChunk | TurnApprovalNoteChunk | TurnSteerChunk>;
};

function messagesFrom(
  chunks: readonly TurnChunk[],
  read: HistoryRead,
  seed: () => CompletionMessage[],
  stopBefore?: CompactJob,
): HistorySlice {
  let eaten: CompletionMessage[] | null = null;
  let last: CompletionExpectation | null = null;
  const tools: Array<ToolCallJob | ProgrammaticJob> = [];
  const notifies: TurnNotificationChunk[] = [];
  const notes: TurnApprovalNoteChunk[] = [];
  const steers: TurnSteerChunk[] = [];
  const resetRound = (): void => {
    last = null;
    tools.length = 0;
    notifies.length = 0;
    notes.length = 0;
    steers.length = 0;
  };
  for (const event of walkTranscript(chunks)) {
    switch (event.kind) {
      case "compact": {
        const eat =
          last != null
            ? [...last.messages, last, ...tools, ...notifies, ...notes, ...steers]
            : [...(eaten ?? seed()), ...notifies, ...notes, ...steers];
        if (stopBefore != null && event.chunk === stopBefore) {
          return {
            messages: eat,
            anchored: last != null,
            replaced: true,
            pending: [],
          };
        }
        eaten = projectCompactMessages(eat, event.chunk, chunks, read);
        resetRound();
        break;
      }
      case "completion": {
        last = event.chunk;
        tools.length = 0;
        notifies.length = 0;
        notes.length = 0;
        steers.length = 0;
        break;
      }
      case "tool": {
        if (jobTriggersReactLoop(event.chunk)) tools.push(event.chunk);
        break;
      }
      case "scheme": {
        tools.push(event.chunk);
        break;
      }
      case "notify": {
        notifies.push(event.chunk);
        break;
      }
      case "approval-note": {
        notes.push(event.chunk);
        break;
      }
      case "steer": {
        steers.push(event.chunk);
        break;
      }
      default:
        break;
    }
  }
  if (last != null) {
    return {
      messages: [...last.messages, last, ...tools, ...notifies, ...notes, ...steers],
      anchored: true,
      replaced: false,
      pending: [],
    };
  }
  return {
    messages: eaten ?? [],
    anchored: false,
    replaced: eaten != null,
    pending: [...notifies, ...notes, ...steers],
  };
}

export function* walkTranscript(chunks: readonly unknown[]): Generator<TranscriptEvent> {
  for (const chunk of chunks) {
    if (chunk instanceof CompactJob && chunk.cutoff) {
      yield { kind: "compact", chunk };
      continue;
    }
    const pew = tapeCompletion(chunk);
    if (pew != null) {
      yield { kind: "completion", chunk: pew };
      continue;
    }
    if (chunk instanceof CompletionExpectation) {
      yield { kind: "completion", chunk };
      continue;
    }
    if (chunk instanceof ToolCallJob) {
      yield { kind: "tool", chunk };
    } else if (chunk instanceof ProgrammaticJob) {
      yield { kind: "scheme", chunk };
    } else if (chunk instanceof TurnNotificationChunk) {
      yield { kind: "notify", chunk };
    } else if (chunk instanceof TurnApprovalNoteChunk) {
      yield { kind: "approval-note", chunk };
    } else if (chunk instanceof TurnSteerChunk) {
      yield { kind: "steer", chunk };
    } else if (typeof chunk === "string" || chunk instanceof MessageChunk) {
      yield { kind: "cell", chunk };
    }
  }
}

export type TranscriptRound = {
  readonly start: number;
  readonly end: number;
  readonly prompt: string;
  readonly response: CompletionExpectation;
  readonly toolCalls: ReadonlyArray<ToolCallJob | ProgrammaticJob>;
};

@arrival.private
export class Transcript {
  static empty(cap = 0): Transcript {
    return new Transcript([], cap);
  }

  static fromCells(cells: readonly EatCell[], cap?: number, cards?: Iterable<EatCell>): Transcript {
    return new Transcript(cells, cap ?? inferCap(cells), cards);
  }

  static fromWork(work: readonly unknown[], cap?: number): Transcript {
    const cells: EatCell[] = [];
    const cards = new Set<EatCell>();
    for (const event of walkTranscript(work)) {
      if (event.kind === "compact") {
        const projected = projectCompactMessages(cells, event.chunk, work, {
          tailNeed: null,
          kv: {},
          configFloor: COMPACT_KEEP_DIAL,
        });
        cells.length = 0;
        cards.clear();
        for (const cell of projected) {
          cells.push(cell);
          if (cell instanceof CompactJob) cards.add(cell);
        }
        continue;
      }
      cells.push(event.chunk);
    }
    return new Transcript(cells, cap ?? inferCap(cells), cards);
  }

  /** Occupancy window start — see preamble. */
  readonly baseGauge: number;
  private readonly checkIns: ReadonlySet<EatCell>;

  constructor(
    readonly cells: readonly EatCell[],
    readonly cap: number,
    checkIns?: Iterable<EatCell>,
    baseGauge = 0,
  ) {
    this.baseGauge = baseGauge;
    this.checkIns = checkIns instanceof Set ? checkIns : new Set(checkIns);
  }

  isCheckIn(cell: EatCell): boolean {
    return this.checkIns.has(cell) || cell instanceof CompactJob || (cell instanceof MessageChunk && cell.checkIn);
  }

  checkInCells(): EatCell[] {
    return this.cells.filter((cell) => this.isCheckIn(cell));
  }

  /** The transcript without its prior-card cells: what happened since, not what was already folded. */
  withoutCheckIns(): Transcript {
    return new Transcript(
      this.cells.filter((cell) => !this.isCheckIn(cell)),
      this.cap,
      [],
      this.baseGauge,
    );
  }

  sliceCells(from: number, to: number = this.cells.length): Transcript {
    const lo = Math.max(0, from);
    const hi = Math.min(this.cells.length, to);
    const sliced = this.cells.slice(lo, hi);
    let baseGauge = this.baseGauge;
    for (let i = Math.min(lo, this.cells.length) - 1; i >= 0; i--) {
      const cell = this.cells[i];
      if (cell instanceof CompletionExpectation && cell.totalTokens != null && cell.totalTokens > 0) {
        baseGauge = cell.totalTokens;
        break;
      }
    }
    return new Transcript(sliced, this.cap, this.checkIns, baseGauge);
  }

  /** `sliceRounds(0, …)` includes prior cards — see preamble. */
  sliceRounds(from: number, to: number): Transcript {
    const rounds = this.rounds();
    if (from >= to || rounds.length === 0) {
      return new Transcript([], this.cap, this.checkIns, this.baseGauge);
    }
    const start = from === 0 ? 0 : (rounds[from]?.start ?? this.cells.length);
    const end = rounds[to - 1]?.end ?? start;
    return this.sliceCells(start, end);
  }

  rounds(): TranscriptRound[] {
    const out: TranscriptRound[] = [];
    let response: CompletionExpectation | null = null;
    let toolCalls: Array<ToolCallJob | ProgrammaticJob> = [];
    let start = 0;

    const flush = (end: number): void => {
      if (response == null) return;
      out.push({
        start,
        end,
        prompt: response.userPrompt,
        response,
        toolCalls,
      });
      response = null;
      toolCalls = [];
    };

    for (const [i, cell_] of this.cells.entries()) {
      const cell = cell_!;
      if (cell instanceof CompletionExpectation) {
        flush(i);
        response = cell;
        start = i;
      } else if ((cell instanceof ToolCallJob || cell instanceof ProgrammaticJob) && response != null) {
        toolCalls.push(cell);
      }
    }
    flush(this.cells.length);
    return out;
  }

  /** Occupancy — see preamble. */
  tokensUsed(): number {
    let lastGauge = -1;
    let lastIndex = -1;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (cell instanceof CompletionExpectation && cell.totalTokens != null && cell.totalTokens > 0) {
        lastGauge = cell.totalTokens;
        lastIndex = i;
      }
    }
    if (lastIndex === -1) return contentTokensOf(this.cells);
    const gauged = Math.max(0, lastGauge - this.baseGauge);
    return gauged + contentTokensOf(this.cells.slice(lastIndex + 1));
  }

  /**
   * The frontier is the OLDEST round of this transcript. During the classify
   * walk `preserve-transcript` runs frontier → newest (chronological), so the
   * round being decided is the first one.
   */
  frontierRound(): Transcript {
    const rounds = this.rounds();
    if (rounds.length === 0) return new Transcript([], this.cap, this.checkIns, this.baseGauge);
    return this.sliceRounds(0, 1);
  }

  /** `transcript/newer`: preserve without the frontier — drop the oldest round. */
  withoutFrontier(): Transcript {
    const rounds = this.rounds();
    if (rounds.length <= 1) return new Transcript([], this.cap, this.checkIns, this.baseGauge);
    return this.sliceRounds(1, rounds.length);
  }

  /** `transcript/older`: compact without the frontier — drop the newest round. */
  withoutNewest(): Transcript {
    const rounds = this.rounds();
    if (rounds.length <= 1) return new Transcript([], this.cap, this.checkIns, this.baseGauge);
    return this.sliceRounds(0, rounds.length - 1);
  }

  completeRounds(): Transcript {
    const rounds = this.rounds();
    if (rounds.length === 0) return new Transcript([], this.cap, this.checkIns, this.baseGauge);
    const last = rounds.at(-1);
    if (last && isRoundComplete(last)) return this.sliceRounds(0, rounds.length);
    if (rounds.length === 1) return new Transcript([], this.cap, this.checkIns, this.baseGauge);
    return this.sliceRounds(0, rounds.length - 1);
  }

  partialRound(): Transcript | null {
    const rounds = this.rounds();
    if (rounds.length === 0) return null;
    const last = rounds.at(-1);
    if (last && isRoundComplete(last)) return null;
    return this.sliceRounds(rounds.length - 1, rounds.length);
  }

  concat(other: Transcript): Transcript {
    const checkIns = new Set(this.checkIns);
    for (const cell of other.checkIns) checkIns.add(cell);
    for (const cell of other.cells) {
      if (other.isCheckIn(cell)) checkIns.add(cell);
    }
    return new Transcript([...this.cells, ...other.cells], this.cap || other.cap, checkIns, this.baseGauge);
  }
}

/**
 * Content-token stand-in: `ceil(chars / 4)`. Replace this one function when
 * per-cell prompt/response tokens exist on the model.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Content meter — see preamble. */
export function contentTokensOf(cells: readonly unknown[]): number {
  let used = 0;
  for (const cell of cells) used += estimateTokens(textOfCell(cell));
  return used;
}

export function charsOf(cells: readonly unknown[]): number {
  let n = 0;
  for (const cell of cells) n += textOfCell(cell).length;
  return n;
}

export function inferCap(cells: readonly unknown[], fallback = 0): number {
  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i];
    if (cell instanceof CompletionExpectation && (cell.contextLimit ?? 0) > 0) {
      return cell.contextLimit ?? 0;
    }
  }
  return fallback;
}

export function payloadSuffix(transcript: Transcript, n: number): EatCell[] {
  const cells = transcript.cells.filter((cell) => !transcript.isCheckIn(cell));
  if (n <= 0 || cells.length === 0) return [];
  const start = Math.max(0, cells.length - Math.floor(n));
  let owner = start;
  while (
    owner > 0 &&
    (cells[owner] instanceof ToolCallJob ||
      cells[owner] instanceof ProgrammaticJob ||
      cells[owner] instanceof TurnNotificationChunk ||
      cells[owner] instanceof TurnApprovalNoteChunk ||
      cells[owner] instanceof TurnSteerChunk)
  ) {
    owner--;
  }
  if (!(cells[owner] instanceof CompletionExpectation)) owner = start;
  return cells.slice(owner);
}

function isRoundComplete(round: TranscriptRound): boolean {
  const requested = round.response.responseCalls.length;
  const hasResponse = round.response.responseText !== "" || (round.response.totalTokens ?? 0) > 0;
  if (requested === 0) return hasResponse;
  if (round.toolCalls.length < requested) return false;
  return round.toolCalls.every((tool) => {
    const json = tool instanceof ToolCallJob ? tool.sealedOutcomeJson() : tool.receiptJson;
    return json != null && json !== "";
  });
}

/** Floors are non-zero by default; a single-round eat legitimately keeps all. */
export function sliceCompactEat(
  eat: Transcript,
  floors: { readonly userTurns: number; readonly rounds: number },
): { readonly prefix: Transcript; readonly keep: Transcript } {
  const rounds = eat.rounds();
  const emptyKeep = eat.sliceCells(eat.cells.length);
  if (rounds.length === 0) return { prefix: eat, keep: emptyKeep };
  let keepRounds = floors.rounds;
  const userTurns = floors.userTurns;
  if (keepRounds > 0 || userTurns > 0) keepRounds = Math.max(keepRounds, 1);
  let keepFrom = rounds.length;
  if (keepRounds > 0) keepFrom = Math.min(keepFrom, Math.max(0, rounds.length - keepRounds));
  if (userTurns > 0) {
    let counted = 0;
    let idx = rounds.length;
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
      if (rounds[i]!.prompt !== "") counted += 1;
      idx = i;
      if (counted >= userTurns) break;
    }
    if (counted > 0) keepFrom = Math.min(keepFrom, idx);
  }
  // Preserve floors are a preference, not a right to keep everything. Clamp so
  // >= 2 rounds always leaves one round in the prefix. One round still keeps all.
  if (rounds.length >= 2 && keepFrom < 1) keepFrom = 1;
  if (keepFrom >= rounds.length) return { prefix: eat, keep: emptyKeep };
  if (keepFrom <= 0) return { prefix: eat.sliceRounds(0, 0), keep: eat };
  return {
    prefix: eat.sliceRounds(0, keepFrom),
    keep: eat.sliceRounds(keepFrom, rounds.length),
  };
}

/**
 * Keep is {@link sliceCompactEat}'s suffix. Squeeze is up to `floors.rounds`
 * rounds immediately before that keep, taken from the prefix. If the squeeze
 * would empty the prefix and at least two rounds exist, shrink the squeeze
 * (to zero when the prefix is a single round) so one round stays in it.
 */
export function sliceCompactZones(
  eat: Transcript,
  floors: { readonly userTurns: number; readonly rounds: number },
): {
  readonly prefix: Transcript;
  readonly squeeze: Transcript;
  readonly keep: Transcript;
} {
  const sliced = sliceCompactEat(eat, floors);
  const empty = eat.sliceRounds(0, 0);
  const prefixRounds = sliced.prefix.rounds();
  let squeezeCount = Math.min(Math.max(0, floors.rounds), prefixRounds.length);
  if (eat.rounds().length >= 2 && prefixRounds.length - squeezeCount < 1) {
    squeezeCount = Math.max(0, prefixRounds.length - 1);
  }
  if (squeezeCount <= 0) return { prefix: sliced.prefix, squeeze: empty, keep: sliced.keep };
  const prefixEnd = prefixRounds.length - squeezeCount;
  return {
    prefix: sliced.prefix.sliceRounds(0, prefixEnd),
    squeeze: sliced.prefix.sliceRounds(prefixEnd, prefixRounds.length),
    keep: sliced.keep,
  };
}

export type CompactProjectionRow =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "keep"; readonly cell: CompletionMessage };

/** Squeeze band as role rows, then keep cells verbatim. The card is separate. */
export function projectCompactRows(
  eat: Transcript,
  floors: { readonly userTurns: number; readonly rounds: number },
): {
  readonly zones: ReturnType<typeof sliceCompactZones>;
  readonly rows: CompactProjectionRow[];
} {
  const zones = sliceCompactZones(eat, floors);
  const rows: CompactProjectionRow[] = [];
  for (const round of zones.squeeze.rounds()) {
    const promptText = round.prompt.trim();
    const response = round.response.responseText.trim();
    if (promptText !== "") rows.push({ kind: "user", text: promptText });
    if (response !== "") rows.push({ kind: "assistant", text: response });
    for (const tool of round.toolCalls) {
      if (tool instanceof ToolCallJob && !jobTriggersReactLoop(tool)) continue;
      const line = compactToolLine(tool).trim();
      if (line === "") continue;
      const name = (tool instanceof ToolCallJob ? tool.name : tool.toolName).trim();
      rows.push({
        kind: "user",
        text: `[${name === "" ? "tool" : name}] ${line}`,
      });
    }
  }
  for (const cell of zones.keep.cells) {
    if (cell instanceof MessageChunk) continue;
    if (isCompletionMessage(cell)) rows.push({ kind: "keep", cell });
  }
  return { zones, rows };
}

/**
 * The card is the `CompactJob` itself, a typed cell (F10): `Transcript` then
 * knows it is a prior card, and `transcript/compaction-results` is no longer
 * always empty. Its text is `standIn`.
 */
export function projectionMessages(card: CompactJob, rows: readonly CompactProjectionRow[]): CompletionMessage[] {
  const out: CompletionMessage[] = [];
  if (card.standIn.trim() !== "") out.push(card);
  for (const row of rows) {
    if (row.kind === "keep") out.push(row.cell);
    else if (row.text !== "") out.push(row.text);
  }
  return out;
}

function floorsFor(job: CompactJob, chunks: readonly unknown[], read: HistoryRead) {
  const index = chunks.indexOf(job);
  const before = index === -1 ? chunks : chunks.slice(0, index);
  const need = contextNeedFromChunks(before, read.tailNeed);
  return keepFloorsOfJob(job, need, read);
}

/** Card, squeeze lines, and verbatim keep cells for the wire and the next eat. */
export function compactLeadRows(turn: SessionTurn, job: CompactJob, read?: CompactRead): CompactProjectionRow[] {
  const ctx = historyRead(turn, read);
  const eat = eatBeforeCompact(turn, job, read);
  const { rows } = projectCompactRows(Transcript.fromCells(eat), floorsFor(job, turnSpine(turn), ctx));
  const card = job.standIn.trim();
  return card === "" ? rows : [{ kind: "user" as const, text: card }, ...rows];
}

function projectCompactMessages(
  eat: readonly EatCell[],
  job: CompactJob,
  chunks: readonly unknown[],
  read: HistoryRead,
): CompletionMessage[] {
  const { rows } = projectCompactRows(Transcript.fromCells(eat), floorsFor(job, chunks, read));
  return projectionMessages(job, rows);
}

function isCompletionMessage(cell: EatCell): cell is CompletionMessage {
  return !(cell instanceof MessageChunk);
}

export function textOfCell(cell: unknown): string {
  if (typeof cell === "string") return cell;
  if (cell instanceof CompactJob) return cell.standIn.trim();
  if (cell instanceof MessageChunk) return cell.text;
  if (cell instanceof TurnNotificationChunk) return cell.notificationText();
  if (cell instanceof TurnApprovalNoteChunk) return cell.approvalNoteText();
  if (cell instanceof TurnSteerChunk) return cell.completionMessage;
  if (cell instanceof ToolCallJob) {
    const scheme = cell.children.find((child): child is ProgrammaticJob => child instanceof ProgrammaticJob);
    if (scheme !== undefined) {
      return `scheme ${scheme.expr} ${scheme.resultText()}`.trim();
    }
    const painted = toolCallRepresentation(cell);
    return `${painted.name} ${painted.args} ${painted.result}`.trim();
  }
  if (cell instanceof ProgrammaticJob) {
    return `scheme ${cell.expr} ${cell.resultText()}`.trim();
  }
  const pew = tapeCompletion(cell) ?? (cell instanceof CompletionExpectation ? cell : null);
  if (pew != null) {
    return `${pew.userPrompt}\n${pew.responseText}`.trim();
  }
  return "";
}
