/**
 * Terminal receipt on {@link CallJob}. Kind is the class.
 * Fail `message` is an error string (approval comment, door text) — not the result.
 */
import { PlexusModel, syncing } from "@here.build/plexus";
import { computed } from "mobx";

import { deepFreeze, syncingText } from "../../json-record.js";

export const CALL_FAIL_CODES = [
  "cancelled",
  "expired",
  "rejected",
  "unknown_recipe",
  "denied",
  "schema_requires_one_shot",
  "caller_missing",
  "worker_missing",
  "spec_required",
  "host_tool",
  "bad_model",
  "error",
  "response_schema",
  "depth_limit",
] as const;
export type CallFailCode = (typeof CALL_FAIL_CODES)[number];

@syncing("harness:job:call-outcome:success")
export class SuccessfulOutcome extends PlexusModel {
  @syncing private accessor valueJson: string | null = null;

  constructor(props?: { readonly valueJson?: string | null } | symbol) {
    super(props);
  }

  @computed
  get value(): unknown {
    return parseOutcomeValue(this.valueJson);
  }

  set value(next: unknown) {
    this.valueJson = stringifyOutcomeValue(next);
  }

  /** Stored JSON. Missing and blank are empty text. Not a re-stringify of {@link value}. */
  valueText(): string {
    return syncingText(this.valueJson) ?? "";
  }
}

@syncing("harness:job:call-outcome:failure")
export class FailureOutcome extends PlexusModel {
  /** Empty is unstamped, outside CALL_FAIL_CODES. */
  @syncing accessor code: CallFailCode | "" = "";
  @syncing accessor message: string = "";

  constructor(props?: { readonly code?: CallFailCode; readonly message?: string } | symbol) {
    super(props);
  }
}

export type CallOutcome = SuccessfulOutcome | FailureOutcome;

export function stringifyOutcomeValue(value: unknown): string | null {
  if (value == null) return null;
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : null;
  } catch {
    return JSON.stringify(String(value));
  }
}

export function parseOutcomeValue(valueJson: unknown): unknown {
  if (typeof valueJson !== "string") return valueJson ?? null;
  if (valueJson.trim() === "") return null;
  try {
    return deepFreeze(JSON.parse(valueJson));
  } catch {
    return valueJson;
  }
}
