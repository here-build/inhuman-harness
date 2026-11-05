/**
 * YAML connection inventory. Settings ride a private synced bag; the public
 * face is {@link configuration} (deep-readonly get, whole-bag set).
 * Secrets never live here. PEW process facts are `readyState` / `error`
 * plus {@link live}. YAML file fill does not touch process facts.
 */
import { Model, model, state } from "@inhuman.tools/model";
import { computed } from "mobx";

import type { ReadyState, SpecCatalog } from "../types.js";
import { DriverSpec } from "./DriverSpec.js";
import { readJsonRecord, writeJsonRecord, type LiveFacts } from "./jsonRecord.js";

export type ConfigurationAtom = string | number | boolean | null;
export type ConfigurationValue =
  | ConfigurationAtom
  | readonly ConfigurationValue[]
  | { readonly [key: string]: ConfigurationValue };
export type ConnectionConfiguration = { readonly [key: string]: ConfigurationValue };

@model("@inhuman.tools/plexus-expectations:ConnectionSpec")
export class ConnectionSpec extends Model<any, SpecCatalog | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? "";
  }

  /** Only `failed` is a problem. */
  get issue(): "failed" | false {
    return this.readyState === "failed" ? "failed" : false;
  }

  /** YAML `driver:` resolves to this entity. */
  @state.ref accessor driver!: DriverSpec;
  @state accessor name: string = "";
  @state accessor annotation: string = "";
  @state.record private accessor configurationMap: Record<string, string> = {};

  /** PEW instance self-report. `null` = never ensured. YAML fill does not touch this. */
  @state accessor readyState: ReadyState = null;
  @state accessor error: string = "";
  @state.record private accessor liveMap: Record<string, string> = {};

  /** Frozen through; assign the whole bag to write. */
  @computed
  get configuration(): ConnectionConfiguration {
    return readJsonRecord(this.configurationMap) as ConnectionConfiguration;
  }

  set configuration(settings: Readonly<Record<string, unknown>> | undefined) {
    this.#writeConfiguration(settings);
  }

  @state.action
  #writeConfiguration(settings: Readonly<Record<string, unknown>> | undefined): void {
    writeJsonRecord(this.configurationMap, settings);
  }

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

  /** Process self-report. YAML fill does not call this. */
  @state.action
  stampProcess(next: {
    readonly readyState: ReadyState;
    readonly error: string;
    readonly live: Readonly<Record<string, unknown>> | undefined;
  }): void {
    this.readyState = next.readyState;
    this.error = next.error;
    this.live = next.live;
  }
}

