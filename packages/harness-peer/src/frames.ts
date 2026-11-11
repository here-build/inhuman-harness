import {
  planeWireFrameSchema,
  storedModelRowSchema,
  type PlaneWireFrame,
  type PresenceEntryTuple,
  type PresenceQueryFrame,
  type PresenceStateFrame,
  type PresenceUpdateFrame,
  type ShapeDeltaFrame,
  type ShapeSubscribeFrame,
  type ShapeUnsubscribeFrame,
  type StreamDeltaFrame,
} from "@inhuman.tools/harness-contract/schema";
import type { DocumentContainer, Model, PresenceEntry, SerializedModelRow } from "@inhuman.tools/model";

export type {
  PlaneWireFrame,
  PresenceEntryTuple,
  PresenceQueryFrame,
  PresenceStateFrame,
  PresenceUpdateFrame,
  ShapeDeltaFrame,
  ShapeSubscribeFrame,
  ShapeUnsubscribeFrame,
  StreamDeltaFrame,
};

export function encodePlaneFrame(frame: PlaneWireFrame): string {
  return JSON.stringify(frame);
}

export function decodePlaneFrame(raw: unknown): PlaneWireFrame | null {
  let value = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "ping" || trimmed === "pong") return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = planeWireFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function encodePresenceQuery(room?: string): string {
  const frame: PresenceQueryFrame = room ? { kind: "presence/query", room } : { kind: "presence/query" };
  return JSON.stringify(frame);
}

function toPresenceTuples(entries: readonly PresenceEntry[]): PresenceEntryTuple[] {
  return entries.map(([clientId, state, clock]) =>
    clock === undefined ? [clientId, state] : [clientId, state, clock],
  );
}

export function encodePresenceUpdate(entries: readonly PresenceEntry[], room?: string): string {
  const normalized = toPresenceTuples(entries);
  const frame: PresenceUpdateFrame = room
    ? { kind: "presence/update", room, entries: normalized }
    : { kind: "presence/update", entries: normalized };
  return JSON.stringify(frame);
}

export function encodePresenceState(entries: readonly PresenceEntry[], room?: string): string {
  const normalized = toPresenceTuples(entries);
  const frame: PresenceStateFrame = room
    ? { kind: "presence/state", room, entries: normalized }
    : { kind: "presence/state", entries: normalized };
  return JSON.stringify(frame);
}

export function encodeShapeSubscribe(frame: ShapeSubscribeFrame): string {
  return JSON.stringify(frame);
}

export function encodeShapeUnsubscribe(subscriptionId: string): string {
  const frame: ShapeUnsubscribeFrame = { kind: "shape/unsubscribe", subscriptionId };
  return JSON.stringify(frame);
}

export function encodeShapeDelta(frame: ShapeDeltaFrame): string {
  return JSON.stringify(frame);
}

export function applyNodeShapeDelta<TRoot extends Model>(
  container: DocumentContainer<TRoot, any>,
  delta: Pick<ShapeDeltaFrame, "upserts" | "deletes" | "reset">,
): void {
  let rootId: string | undefined;
  let maxRevision: number | undefined;
  const modelUpserts: SerializedModelRow[] = [];

  for (const raw of delta.upserts) {
    const rawRowJson = raw.rowJson ?? raw.row_json;
    if (typeof rawRowJson !== "string") continue;
    const parsedRow = storedModelRowSchema.parse(JSON.parse(rawRowJson));
    modelUpserts.push(parsedRow);

    const isRoot = raw.isRoot === true || raw.isRoot === 1 || raw.is_root === true || raw.is_root === 1;
    if (isRoot) {
      rootId = parsedRow.uuid;
    }
    const rev = typeof raw.revision === "number" ? raw.revision : Number(raw.revision);
    if (Number.isFinite(rev)) {
      maxRevision = maxRevision === undefined ? rev : Math.max(maxRevision, rev);
    }
  }

  container.applyNodeRows({
    rootId,
    revision: maxRevision,
    upserts: modelUpserts,
    deletes: delta.deletes,
    reset: delta.reset,
  });
}
