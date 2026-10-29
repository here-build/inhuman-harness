/**
 * YAML connection inventory. Settings ride a private synced bag; the public
 * face is {@link configuration} (deep-readonly get, whole-bag set).
 * Secrets never live here. PEW process facts are `readyState` / `error`
 * plus {@link live}. YAML file fill does not touch process facts.
 */
import { PlexusModel, syncing } from "@here.build/plexus";
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

@syncing("@inhuman.tools/plexus-expectations:ConnectionSpec")
export class ConnectionSpec extends PlexusModel<SpecCatalog | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? "";
  }

  /** Only `failed` is a problem. */
  get issue(): "failed" | false {
    return this.readyState === "failed" ? "failed" : false;
  }

  /** YAML `driver:` resolves to this entity. */
  @syncing accessor driver!: DriverSpec;
  @syncing accessor name: string = "";
  @syncing accessor annotation: string = "";
  @syncing.record private accessor configurationMap: Record<string, string> = {};

  /** PEW instance self-report. `null` = never ensured. YAML fill does not touch this. */
  @syncing accessor readyState: ReadyState = null;
  @syncing accessor error: string = "";
  @syncing.record private accessor liveMap: Record<string, string> = {};

  /** Frozen through; assign the whole bag to write. */
  @computed
  get configuration(): ConnectionConfiguration {
    return readJsonRecord(this.configurationMap) as ConnectionConfiguration;
  }

  set configuration(settings: Readonly<Record<string, unknown>> | undefined) {
    this.#writeConfiguration(settings);
  }

  @syncing.action
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

  @syncing.action
  #writeLive(next: Readonly<Record<string, unknown>> | undefined): void {
    writeJsonRecord(this.liveMap, next);
  }

  /** Process self-report. YAML fill does not call this. */
  @syncing.action
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

