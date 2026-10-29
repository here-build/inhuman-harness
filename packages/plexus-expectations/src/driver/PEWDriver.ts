import { DefaultedWeakMap } from "@here.build/collections";
import type { PlexusAwareness } from "@here.build/plexus";
import { action, computed, observable, toJS } from "mobx";

import type { ExpectationActor } from "./ExpectationActor.js";
import { pewConfigurationSchema, pewSecretsSchema } from "../schemas/connection.js";
import type { AnyWorkExpectation, WorkExpectation } from "../shared/models/WorkExpectation.js";
import { revalidationDemandOf, type RevalidationDemand } from "../shared/revalidation-demand.js";
import type { ReadyState } from "../shared/types.js";

/** Duck-typed — drivers may ship a different Zod major than this package. */
export type ConfigurationSchema = {
  safeParse(
    data: unknown,
  ):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false; readonly error: { readonly issues: ReadonlyArray<{ readonly message?: string }> } };
};

/** Process-local. Secrets are never a Plexus field. */
export type ConnectionSecretsView = {
  readonly revision?: number;
  get(field: string): unknown | undefined;
  /** MCP env_* enumerates deposited fields. */
  all?(): Readonly<Record<string, unknown>> | undefined;
  /** Hosts that persist a refreshed session (reauth) implement this. */
  replace?(secrets: Readonly<Record<string, string>>): void;
};

const EMPTY_SECRETS: ConnectionSecretsView = { get: () => undefined };

/** Module-graph duplication breaks instanceof; the elevation gate checks this brand too. */
// eslint-disable-next-line no-secrets/no-secrets -- package identity tag, not a secret
export const PEW_DRIVER_BRAND = "@inhuman.tools/plexus-expectations:PEWDriver@1";

/** A connection construction the driver already knows will work. */
export type DriverOffer = {
  readonly name: string;
  readonly description: string;
  readonly live: boolean;
  readonly adoptable: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
};

/**
 * Driver extras the orchestrator mirrors onto `spec.live`.
 * Core process facts live on `readyState` / `error` / `offers`.
 */
export function extraLiveFromState(state: object): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined) continue;
    extra[key] = toJS(value);
  }
  return extra;
}

/**
 * The CLASS is the driver (one loaded module per driver name).
 * The INSTANCE is a live connection (one per connection id).
 *
 * CLAIM DOES NOT LIVE HERE. Which WorkExpectation classes this driver handles
 * lives on the advertised driver record (`can`): dynamically loaded code does
 * not get to declare its own authority.
 *
 * Live state is report only — no machinery branches on it. Instance bootstrap
 * truth is `bootstrapDone` / `bootstrapPending`. Drivers read {@link attention}
 * as the reduced token, never clientIds.
 *
 * YAML doors ({@link configurationSchema} / {@link secretsSchema}) parse
 * without `new`. Secrets stay a live view — the host may replace it (reauth).
 */
export abstract class PEWDriver<
  E extends AnyWorkExpectation = AnyWorkExpectation,
  C = Readonly<Record<string, unknown>>,
> implements AsyncDisposable {
  // ── driver side (the CLASS is the driver) ─────────────────────────────
  static readonly pewBrand: string = PEW_DRIVER_BRAND;

  /**
   * YAML settings shape. Default is a passthrough record — subclasses replace
   * this with a real object schema (transforms included). First issue message
   * is what construct / parse throw.
   */
  static readonly configurationSchema: ConfigurationSchema = pewConfigurationSchema;

  static readonly configurationLabel: string = "";

  static configurationError(message: string): string {
    const label = this.configurationLabel.trim();
    return label === "" ? `connection config invalid: ${message}` : `${label} connection config invalid: ${message}`;
  }

  /** YAML settings door. Does not construct an instance. */
  static parseConfiguration(settings: unknown = {}): unknown {
    const result = this.configurationSchema.safeParse(settings ?? {});
    if (result.success) return result.data;
    const message = result.error.issues[0]?.message ?? "invalid";
    throw new Error(this.configurationError(message));
  }

  static readonly secretsSchema: ConfigurationSchema = pewSecretsSchema;

  static secretsError(message: string): string {
    const label = this.configurationLabel.trim();
    return label === "" ? `connection secrets invalid: ${message}` : `${label} connection secrets invalid: ${message}`;
  }

  /** YAML secrets door. Does not construct an instance. */
  static parseSecrets(secrets: unknown = {}): unknown {
    const result = this.secretsSchema.safeParse(secrets ?? {});
    if (result.success) return result.data;
    const message = result.error.issues[0]?.message ?? "invalid";
    throw new Error(this.secretsError(message));
  }

  /** Shared on the prototype chain — own extras per subclass. */
  static readonly state: Record<string, unknown> = {};
  /**
   * A plain list, or a getter over observable state when the driver keeps its
   * offers fresh (local detection). The orchestrator mirrors it onto
   * `DriverSpec.offers` with a reaction, which is also what observes it.
   */
  static readonly offers: readonly DriverOffer[] = [];

  /** Kernel-plane occupancy hub. Orchestrator assignment is own-per-class. */
  static awareness: PlexusAwareness | undefined;
  static driverName = "";

  /**
   * A getter, not `@computed` — MobX: the decorator's initializer pins to the
   * declaring class, so subclasses would share one computed.
   */
  static get revalidationDemand(): RevalidationDemand {
    const hub = this.awareness;
    const name = this.driverName;
    if (hub === undefined || name === "") return "none";
    return revalidationDemandOf(hub, { kind: "driver", name });
  }

  // ── connection side (the INSTANCE is the connection) ──────────────────
  @observable accessor readyState: ReadyState = null;
  @observable accessor error: string = "";
  /**
   * MobX: shallow — extras (models, tools, account) are replaced wholesale.
   * Override the accessor with a wider literal to add driver facts.
   */
  @observable.shallow accessor state: Record<string, unknown> = {};

  @observable.ref accessor awareness: PlexusAwareness | undefined = undefined;

  @computed
  get revalidationDemand(): RevalidationDemand {
    const hub = this.awareness;
    if (hub === undefined) return "none";
    return revalidationDemandOf(hub, { kind: "connection", id: this.connectionId });
  }

  constructor(
    public readonly connectionId: string,
    settings: unknown = {},
    secrets: ConnectionSecretsView | Readonly<Record<string, unknown>> = EMPTY_SECRETS,
  ) {
    const cls = new.target as typeof PEWDriver;
    this.settings = cls.parseConfiguration(settings) as C;
    const view: ConnectionSecretsView =
      typeof (secrets as ConnectionSecretsView).get === "function"
        ? (secrets as ConnectionSecretsView)
        : {
            get: (field) => (secrets as Readonly<Record<string, unknown>>)[field],
            all: () => secrets as Readonly<Record<string, unknown>>,
          };
    cls.parseSecrets(view.all?.() ?? {});
    this.secrets = view;
  }
  readonly settings: C;
  /** Live view. The host may replace it (reauth). */
  secrets: ConnectionSecretsView;

  /**
   * Host binds the disk writer for this connection's settings bag.
   * Parsed settings stay readonly; a driver that learns a value overrides this.
   */
  bindSettingsWriter(_write: (patch: Readonly<Record<string, unknown>>) => void): void {}

  abstract bootstrap(): Promise<void>;

  bootstrapDone = false;
  bootstrapPending: Promise<void> | null = null;
  /** `resolve()` threw — the connection is broken, not the work. */
  broken = false;
  /** Concurrent callers share one promise. Async settlement is its own MobX action. */
  @action
  ensureBootstrapStarted(): Promise<void> {
    if (this.bootstrapDone) return Promise.resolve();
    if (this.bootstrapPending) return this.bootstrapPending;
    this.readyState = "bootstrapping";
    this.error = "";
    this.bootstrapPending = this.bootstrap().then(
      action(() => {
        this.bootstrapDone = true;
        this.readyState = "ready";
        this.error = "";
      }),
      action((error: unknown) => {
        this.readyState = "failed";
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }),
    );
    return this.bootstrapPending;
  }

  @action
  failReady(error: unknown): void {
    this.broken = true;
    this.readyState = "failed";
    this.error = error instanceof Error ? error.message : String(error);
  }

  protected abstract resolve(expectation: E): ExpectationActor<E>;
  /** Nothing in PEW calls this; hosts or tests may. */
  async [Symbol.asyncDispose](): Promise<void> {}

  private readonly actors = new DefaultedWeakMap<WorkExpectation, ExpectationActor<any>>((expectation: WorkExpectation): ExpectationActor<any> => {
  const actor = this.resolve(expectation as E);
  this.liveActors.add(actor);
  return actor;
});
  private readonly liveActors = new Set<ExpectationActor<any>>();

  has(expectation: WorkExpectation): boolean {
    return this.actors.has(expectation);
  }
  resolveExpectation<T extends AnyWorkExpectation>(expectation: T): ExpectationActor<T> {
    return this.actors.get(expectation);
  }
  release(expectation: WorkExpectation): void {
    if (!this.actors.has(expectation)) return;
    const actor = this.actors.get(expectation);
    this.actors.delete(expectation);
    this.liveActors.delete(actor);
    actor.leave();
  }

  /**
   * Logout/drop aborts interned work. Not park. Subclasses abort `#inflight`.
   */
  abortOnDrop(reason: unknown): void {
    for (const actor of this.liveActors) actor.abort(reason);
  }

  /**
   * Honor one demand.
   * `resolve()` throwing is a broken connection, not a failed expectation.
   */
  handle(expectation: WorkExpectation): void {
    if (this.broken) return;
    if (expectation.isDone) return;
    if (this.has(expectation)) {
      const existing = this.resolveExpectation(expectation);
      if (!existing.started) existing.start();
      return;
    }

    let actor: ExpectationActor<any>;
    try {
      actor = this.resolveExpectation(expectation);
    } catch (error) {
      this.failReady(error);
      return;
    }

    // Awareness / host policy may have sealed the work while resolve() ran.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- resolve() can seal via spawn hooks
    if (expectation.isDone) {
      actor.leave();
      return;
    }

    if (!actor.started) {
      actor.start();
    }
  }
}

/**
 * A concrete `PEWDriver` subclass — constructable, not abstract.
 * `loadDriverModule` returns `unknown`; {@link isDriverConnectionClass} is the gate.
 */
export type DriverConnectionClass = {
  [K in keyof typeof PEWDriver]: (typeof PEWDriver)[K];
} & (new (...args: ConstructorParameters<typeof PEWDriver>) => PEWDriver);

export function isDriverConnectionClass(value: unknown): value is DriverConnectionClass {
  if (typeof value !== "function") return false;
  if ((value as { pewBrand?: unknown }).pewBrand === PEW_DRIVER_BRAND) return true;
  return (
    typeof (value as { prototype?: unknown }).prototype === "object" &&
    (value as { prototype: object }).prototype instanceof PEWDriver
  );
}
