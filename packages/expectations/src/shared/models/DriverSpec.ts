/**
 * Advertised driver inventory. `abilityClaim` is a model list — file tokens, no load required.
 * Driver process facts are `readyState` / `error` / `offersJson` plus {@link live}.
 * YAML file fill does not touch process facts.
 */
import { Model, model, state } from "@inhuman.tools/model";
import { computed } from "mobx";
import invariant from "tiny-invariant";

import type { ReadyState, SpecCatalog } from "../types.js";
import { readJsonRecord, writeJsonRecord, type LiveFacts } from "./jsonRecord.js";

/** How a new connection of this driver is offered, before the class loads. */
export type DriverMultiplicity = "add-by-default" | "add-as-secondary";

@model("@inhuman.tools/expectations:DriverSpec")
export class DriverSpec extends Model<any, SpecCatalog | null> {
  @state accessor name: string = "";
  @state accessor description: string = "";
  @state accessor importPath: string = "";
  /** Expectation kind names this driver handles. Not tool names. */
  @state.list accessor abilityClaim: string[] = [];
  @state accessor multiplicity: DriverMultiplicity = "add-as-secondary";

  /** Module-load self-report. `null` = never loaded. YAML fill does not touch this. */
  @state accessor readyState: ReadyState = null;
  @state accessor error: string = "";
  /** Offer list JSON. Null = no offers. */
  @state private accessor offersJson: string | null = null;
  @state.record private accessor liveMap: Record<string, string> = {};

  @computed
  get live(): LiveFacts {
    return readJsonRecord(this.liveMap) as LiveFacts;
  }

  set live(next: Readonly<Record<string, unknown>> | undefined) {
    this.#writeLive(next);
  }

  @state.action
  #writeLive(next: Readonly<Record<string, unknown>> | undefined): void {
    writeJsonRecord(this.liveMap, next);
  }

  /**
   * Module-load self-report. Omitted `offersJson` / `live` stay
   * (failure must not wipe a previous load).
   */
  @state.action
  stampLoad(next: {
    readonly readyState: ReadyState;
    readonly error: string;
    readonly offersJson?: string | null;
    readonly live?: Readonly<Record<string, unknown>>;
  }): void {
    this.readyState = next.readyState;
    this.error = next.error;
    if (next.offersJson !== undefined) this.offersJson = next.offersJson;
    if (next.live !== undefined) this.live = next.live;
  }

  /**
   * Class-bootstrap offers. Null, blank, and the string `"null"` are no offers.
   * A non-string cell or malformed JSON throws: a silent [] hides a driver defect.
   */
  @computed
  get offers(): readonly object[] {
    return readDriverOffers(this.offersJson);
  }

  set offers(next: readonly object[] | null) {
    this.#writeOffers(next);
  }

  @state.action
  #writeOffers(next: readonly object[] | null): void {
    this.offersJson = next == null ? null : JSON.stringify(next);
  }
}

export function readDriverOffers(raw: unknown): object[] {
  if (raw == null) return [];
  invariant(typeof raw === "string", "harness/kernel/offers: offersJson must be a JSON string");
  const text = raw.trim();
  if (text === "" || text === "null") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `harness/kernel/offers: offersJson is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  invariant(Array.isArray(parsed), "harness/kernel/offers: offersJson must be a JSON array of offer objects");
  for (const item of parsed) {
    invariant(typeof item === "object", "harness/kernel/offers: offersJson entries must be objects");
    invariant(item !== null, "harness/kernel/offers: offersJson entries cannot be null");
    invariant(!Array.isArray(item), "harness/kernel/offers: offersJson entries cannot be arrays");
  }
  return parsed as object[];
}
