/**
 * Paint mailbox (structure / box_set / box_free) — the keyed-mirror mailbox
 * discipline for box-cadence hosts. Obeys I1 (`README.md`): paint + mailbox
 * push/peek share one Node event loop, no Atomics, no off-loop paint without
 * a concurrency redesign. (The retired whole-model `LatestMailbox` lives on
 * bench-locally in `src/bench/host.ts`.)
 *
 * Worker → UI: `structure{gen, tree}` (latest-wins by gen), `box_set{boxId,
 * value}` (coalescable per boxId), `box_free{boxIds}` (mirror invalidation).
 * UI → worker: `input_events[]`, `resize{cols, rows}`,
 * `picker_activate{key}`, `picker_scroll{delta}`, `agents_scroll{delta}`,
 * `agents_focus{key}`, `agents_hover{key}`, `activate{key}`.
 *
 * Everything here is structured-clone-safe plain data — no mobx observables,
 * no plexus models, no functions cross this seam. Transport is
 * `worker_threads` postMessage; this module defines the message shapes and
 * the pure mailbox reducer, never the transport.
 */

// — Worker → UI ---------------------------------------------------------

export interface StructureMessage {
  readonly kind: "structure";
  readonly gen: number;
  readonly tree: unknown;
}

export interface BoxSetMessage {
  readonly kind: "box_set";
  /** Worker-minted, opaque integer id — the structure refers to boxes by id only. */
  readonly boxId: number;
  readonly value: unknown;
}

export interface BoxFreeMessage {
  readonly kind: "box_free";
  readonly boxIds: readonly number[];
}

export type BoxBusDownMessage = StructureMessage | BoxSetMessage | BoxFreeMessage;

// — UI → worker -----------------------------------------------------------

/**
 * Decoding lives UI-side with the single decoder; this module carries the
 * ALREADY-DECODED result across the seam. Minimal shape covering the fields a
 * key event needs to be replayed host-side — mirrors the conventional DOM
 * `KeyboardEvent` modifier fields, the smallest vocabulary that lets a
 * consumer distinguish plain keys from chorded ones.
 */
export interface DecodedKeyEvent {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}

export interface InputEventsMessage {
  readonly kind: "input_events";
  readonly events: readonly DecodedKeyEvent[];
}

export interface ResizeMessage {
  readonly kind: "resize";
  readonly cols: number;
  readonly rows: number;
}

export interface PickerActivateMessage {
  readonly kind: "picker_activate";
  readonly key: string;
}

export interface PickerScrollMessage {
  readonly kind: "picker_scroll";
  readonly delta: 1 | -1;
}

/**
 * Bare-click activate (catalog row, button). Distinct from picker_activate —
 * that key is a slash-complete row; this one is any `intent: "activate"` hit.
 */
export interface ActivateMessage {
  readonly kind: "activate";
  readonly key: string;
}

export interface AgentsScrollMessage {
  readonly kind: "agents_scroll";
  readonly delta: 1 | -1;
}

/** Set keyboard home. Pointer path uses {@link AgentsHoverMessage}. */
export interface AgentsFocusMessage {
  readonly kind: "agents_focus";
  readonly key: string;
}

/** Pointer keep-alive over a session row, peek, or gap. Null on leave. */
export interface AgentsHoverMessage {
  readonly kind: "agents_hover";
  readonly key: string | null;
}

export interface SubmitPart {
  readonly text?: string;
  readonly image?: { readonly mime: string; readonly bytes: Uint8Array };
}

export interface SubmitCommand {
  readonly name: string;
  readonly args: Readonly<Record<string, string>>;
}

/** Render → host. Parts are the model prompt. Command is not a part. */
export interface SubmitMessage {
  readonly kind: "submit";
  readonly parts: readonly SubmitPart[];
  readonly command: SubmitCommand | null;
}

export function receiveSubmit(message: { readonly kind: string }): {
  readonly parts: readonly SubmitPart[];
  readonly command: SubmitCommand | null;
} | null {
  if (message.kind !== "submit") return null;
  const submit = message as SubmitMessage;
  return { parts: submit.parts, command: submit.command };
}

export function submitMessage(split: {
  readonly parts: readonly SubmitPart[];
  readonly command: SubmitCommand | null;
}): SubmitMessage {
  return { kind: "submit", parts: split.parts, command: split.command };
}

export type BoxBusUpMessage =
  | InputEventsMessage
  | ResizeMessage
  | PickerActivateMessage
  | PickerScrollMessage
  | AgentsScrollMessage
  | AgentsFocusMessage
  | AgentsHoverMessage
  | ActivateMessage
  | SubmitMessage;

// — The mailbox (pure) -----------------------------------------------------

/** The UI thread's dumb mirror of worker-pushed state. */
export interface BoxMailbox {
  readonly structureGen: number | null;
  readonly tree: unknown;
  readonly boxes: ReadonlyMap<number, unknown>;
}

/**
 * A FRESH empty mailbox, per call.
 *
 * A factory rather than a shared constant: `boxes` is a nested `Map`, which a
 * top-level freeze does not protect at all — `Map.set` ignores frozen-ness of
 * its container — so a single stray write would taint the baseline every later
 * mirror starts from. Today's `applyBoxBusMessage` is copy-on-write and never
 * mutates it, but that is a property of the current call sites, not of the
 * value. Same resolution as the model package's collapse baseline.
 */
export function emptyMailbox(): BoxMailbox {
  return { structureGen: null, tree: null, boxes: new Map() };
}

/**
 * Apply one `BoxBusDownMessage` to the mailbox. Three laws, each one branch:
 * `structure` is latest-wins by gen (stale gens dropped) and replaces
 * tree/gen only — never `boxes`. `box_set` overwrites per-boxId (a `Map.set`
 * on the same key IS the coalesce). `box_free` is the only invalidation
 * (deletes named mirrors). A "new tree → empty Map" edit drops in-flight
 * box_sets that arrived before or with the structure.
 */
export function applyBoxBusMessage(mailbox: BoxMailbox, message: BoxBusDownMessage): BoxMailbox {
  switch (message.kind) {
    case "structure":
      if (mailbox.structureGen !== null && message.gen <= mailbox.structureGen) return mailbox;
      return { ...mailbox, structureGen: message.gen, tree: message.tree };
    case "box_set": {
      const boxes = new Map(mailbox.boxes);
      boxes.set(message.boxId, message.value);
      return { ...mailbox, boxes };
    }
    case "box_free": {
      if (message.boxIds.length === 0) return mailbox;
      const boxes = new Map(mailbox.boxes);
      for (const boxId of message.boxIds) boxes.delete(boxId);
      return { ...mailbox, boxes };
    }
  }
}

/** Fold a whole batch through the mailbox in order — what a UI thread does once per animation frame. */
export function applyBoxBusBatch(mailbox: BoxMailbox, messages: readonly BoxBusDownMessage[]): BoxMailbox {
  return messages.reduce(applyBoxBusMessage, mailbox);
}
