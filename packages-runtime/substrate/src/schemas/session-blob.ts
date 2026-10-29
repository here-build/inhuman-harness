/**
 * The `DoorsRunner` session blob — the serializable teaching state one runner exports
 * (`exportSession`) and another restores (`restoreSession`). It crosses a persistence
 * boundary (disk, a store, another process), so it is UNTRUSTED INPUT: it is parsed here,
 * at the boundary, never asserted into place.
 *
 * WHY A SCHEMA, not the hand-rolled container checks this file replaces: the previous
 * validator gated `Array.isArray(rec.history)` and friends — the CONTAINERS — then
 * returned `rec as unknown as SessionBlob`. Element shapes were never checked, so a blob
 * carrying `history: [{}]` or `futility: ["solo"]` restored as if valid and threw deeper,
 * inside the trackers' own `importState`, where the error says nothing about the blob.
 * The schema checks the elements because that is where the crash actually lived.
 *
 * FORWARD COMPATIBILITY IS PART OF THE FORMAT. Three rules, each with a test:
 *   - Unknown keys are stripped, not fatal (`v4` objects strip by default; `.strip()` is
 *     explicit). A removed key (`competence`) in an old blob is ignored.
 *   - Additive keys are optional (`argsFailures` — absent restores an empty tracker,
 *     the additive-key precedent in design doc §2.4).
 *   - `DoorCode` is `z.string()`, NOT `z.enum(...)`. A code renamed since the blob was
 *     written is harmless: `pendingFollow` values are only ever logged verbatim
 * (`doors.ts` `observeSuccess`), never matched against the current door set. An enum
 *     would make the next door rename reject every older blob — trading a real
 *     compatibility break for a check that protects nothing.
 */
import { z } from "zod";

const sessionHistoryEntry = z.object({
  name: z.string(),
  source: z.string(),
});

const ringEntry = z.object({
  argsHash: z.string(),
  resultHash: z.string(),
  callId: z.number(),
});

const toolState = z.object({
  ring: z.array(ringEntry),
  lastResultHash: z.string().optional(),
  firedFutileHash: z.string().optional(),
  firedDuplicateHash: z.string().optional(),
});

const doorSessionState = z.object({
  seen: z.array(z.string()).readonly(),
  /** DoorCode on the wire, typed loose on purpose — see the file doc. */
  pendingFollow: z.array(z.tuple([z.string(), z.string()]).readonly()).readonly(),
  seq: z.number(),
});

const argsFailureState = z.object({
  /** `[key, count]` pairs. The COUNT is deliberately `z.number()`, not an integer/level
   *  refinement: `ArgsFailureTracker.importState` discards a level that is not a valid
   *  `ArgsFailureLevel` (a tampered `0`, `2.5`, `NaN`) rather than clamping it —
   *  clamping would fabricate an escalation no failure ever earned. The schema proves
   *  the SHAPE; the tracker keeps its own discard-not-clamp contract. */
  entries: z.array(z.tuple([z.string(), z.number()]).readonly()).readonly(),
});

export const sessionBlobSchema = z
  .object({
    v: z.literal(1),
    history: z.array(sessionHistoryEntry).readonly(),
    /** Reserved for future replay-cache support; written as `{}`, unread on restore. */
    cache: z.record(z.string(), z.string()),
    futility: z.array(z.tuple([z.string(), toolState]).readonly()).readonly(),
    localBindings: z.array(z.tuple([z.string(), z.array(z.number()).readonly()]).readonly()).readonly(),
    doorSession: doorSessionState,
    contextRing: z.array(z.tuple([z.string(), z.string()]).readonly()).readonly(),
    argsFailures: argsFailureState.optional(),
  })
  .strip();

export type SessionBlob = z.infer<typeof sessionBlobSchema>;

/** Parse untrusted blob input into a validated `SessionBlob`, or throw naming the
 *  boundary. Replaces the hand-rolled validator in `runner.ts`. */
export function parseSessionBlob(raw: unknown): SessionBlob {
  return sessionBlobSchema.parse(raw);
}
