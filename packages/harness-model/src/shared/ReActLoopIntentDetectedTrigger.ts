/**
 * Text-only continuation intern. `config.json` `reActLoopIntentDetectedTrigger`.
 * General flag plus `connection:model` overlay (first colon). Dict hit
 * wins; missing key inherits `enabled`. Omitted bag is on. Explicit
 * `enabled: false` turns it off. A non-object is off. Actor of the
 * sealed speech, not the judge wire.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import { reActLoopIntentDetectedTriggerFlagsSchema } from "../schemas/re-act-loop-intent-detected-trigger.js";

export {
  parseTextOnlyContinueVote,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_RESPONSE_SCHEMA,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_RESPONSE_SCHEMA_JSON,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_STREAK_MAX,
  shouldIntentContinue,
  type ReActLoopIntentDetectedTriggerVote,
} from "@inhuman.tools/continuation";

export type ReActLoopIntentDetectedTriggerFlags = {
  readonly enabled: boolean;
  readonly models: Readonly<Record<string, boolean>>;
};

@syncing("harness:re-act-loop-intent-detected-trigger")
export class ReActLoopIntentDetectedTrigger extends PlexusModel {
  @syncing accessor enabled: boolean = true;
  @syncing.record accessor models: Record<string, boolean> = {};

  constructor(props?: { readonly enabled?: boolean; readonly models?: Record<string, boolean> } | symbol) {
    super(typeof props === "symbol" ? props : { ...props });
  }

  @syncing.action
  applyFlags(flags: ReActLoopIntentDetectedTriggerFlags): void {
    this.enabled = flags.enabled;
    const next = { ...flags.models };
    for (const key of Object.keys(this.models)) {
      if (!Object.hasOwn(next, key)) delete this.models[key];
    }
    Object.assign(this.models, next);
  }
}

/** Documents that still name this `harness:text-only-continue`. */
@syncing("harness:text-only-continue")
export class TextOnlyContinue extends ReActLoopIntentDetectedTrigger {}

export function parseTextOnlyContinue(value: unknown): ReActLoopIntentDetectedTriggerFlags {
  if (value == null) return { enabled: true, models: {} };
  const parsed = reActLoopIntentDetectedTriggerFlagsSchema.safeParse(value);
  return parsed.success ? parsed.data : { enabled: false, models: {} };
}

/** Actor `connection:model`. First colon splits; models may contain slashes. */
export function reActLoopIntentDetectedTriggerActorKey(connection: string, model: string): string {
  return `${connection.trim()}:${model.trim()}`;
}

export function reActLoopIntentDetectedTriggerFor(
  bag: ReActLoopIntentDetectedTriggerFlags,
  connection: string,
  model: string,
): boolean {
  const conn = connection.trim();
  const mid = model.trim();
  if (conn !== "" && mid !== "") {
    const key = reActLoopIntentDetectedTriggerActorKey(conn, mid);
    if (Object.hasOwn(bag.models, key)) return bag.models[key] === true;
  }
  return bag.enabled === true;
}
