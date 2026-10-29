/**
 * Delivery mark, contribution pause, and join eligibility.
 */
import { createHash } from "node:crypto";

import { BotCallJob, CallJob } from "@inhuman.tools/harness-model";
import type { Job } from "@inhuman.tools/plexus-expectations";
import { type IObservableValue, observable, runInAction } from "mobx";

import type { CallsCatalog } from "./types.js";
import type { PackToolMeta } from "../tool-catalog/index.js";

// A bot call is delivered once its enqueue reached the worker's storage. The
// mark is process-local: a re-run finds the worker's callback row and marks it again.
const deliveries = new WeakMap<BotCallJob, IObservableValue<boolean>>();

function deliveryMark(call: BotCallJob): IObservableValue<boolean> {
  let mark = deliveries.get(call);
  if (mark == null) {
    mark = observable.box(false);
    deliveries.set(call, mark);
  }
  return mark;
}

export function botCallMeta(
  catalog: CallsCatalog,
  wireName: string,
): Extract<PackToolMeta, { kind: "bot-call" }> | undefined {
  const entry = catalog.catalogEntry(wireName);
  return entry?.packMeta?.kind === "bot-call" ? entry.packMeta : undefined;
}

export function markDelivered(call: BotCallJob): void {
  runInAction(() => deliveryMark(call).set(true));
}

export function shouldSkipTurnCancel(call: CallJob, catalog?: CallsCatalog): boolean {
  if (!(call instanceof BotCallJob)) return false;
  const lifetime = call.delivery?.lifetime;
  if (lifetime === "call") return true;
  if (lifetime === "turn") return false;
  if (catalog == null) return false;
  const meta = botCallMeta(catalog, call.name);
  return meta?.lifetime === "call";
}

export function isCallPaused(call: CallJob, catalog: CallsCatalog): boolean {
  if (!(call instanceof BotCallJob) || call.completed) return false;
  if (call.contributionPluginName === "") return false;
  const installed = catalog.pluginInstall?.plugins.get(call.contributionPluginName);
  if (installed != null) {
    if (
      createHash("sha256").update(JSON.stringify(installed.definition)).digest("hex").slice(0, 16) !==
      call.contributionRevision
    )
      return true;
    return catalog.catalogEntry(call.name) == null;
  }
  // A behavior plugin has no compiled install. While it is enabled, the catalog
  // carries its bot's current program revision; a disabled plugin has none.
  const current = catalog.botRevisions.get(call.contributionBotName);
  return current == null || current !== call.contributionRevision;
}

export function joinReleased(job: Job, _catalog: CallsCatalog): boolean {
  if (job.completed) return true;
  if (!job.orchestrated || !job.background) return false;
  if (job instanceof BotCallJob) return deliveryMark(job).get();
  return true;
}
