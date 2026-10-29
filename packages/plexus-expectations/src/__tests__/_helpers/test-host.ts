import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  Plexus,
  PlexusAwareness,
  PlexusModel,
  syncing,
} from "@here.build/plexus";
import { computed, when } from "mobx";
import invariant from "tiny-invariant";
import * as Y from "yjs";

import { ExpectationActor } from "../../driver/ExpectationActor.js";
import { PEWDriver, type DriverConnectionClass } from "../../driver/PEWDriver.js";
import { Orchestrator } from "../../executor/index.js";
import {
  ConnectionSpec,
  DriverSpec,
  WorkExpectation,
  WorkContainer,
  walkWork,
  type ReadyState,
  type KernelPlexus,
  type KernelRootModel,
  type SessionPlexus,
} from "../../shared/index.js";

/** Dual local Y.Docs, no wire. */

export type TestResult = { value?: string };
export type TestReport = { note?: string };
export type TestCatalogRow = {
  readonly id: string;
  readonly name: string;
  readonly driver: DriverSpec;
  readonly settings: Readonly<Record<string, unknown>>;
};

export type TestCatalogFace = {
  readonly id: string;
  readonly name: string;
  readonly readyState: ReadyState | null;
  readonly error: string | null;
  readonly driver?: TestCatalogFace;
};

@syncing("test:PewExpectation")
export class TestExpectation extends WorkExpectation<TestResult, TestReport> {
  @syncing accessor payload: string = "";
  @syncing accessor resultValue: string = "";

  override applySettlement(result: TestResult): void {
    this.resultValue = result.value ?? "";
  }
}

/** Parent PEW that can own nested work (judge channel) for tree-orphan tests. */
@syncing("test:ParentExpectation")
export class TestParent extends TestExpectation {
  @syncing.child.record accessor nested: Record<string, WorkExpectation> = {};

  @computed
  override get work(): readonly WorkExpectation[] {
    return [this, ...Object.values(this.nested)];
  }
}

@syncing("test:ThrowingExpectation")
export class ThrowingExpectation extends TestExpectation {
  override applySettlement(result: TestResult): void {
    this.resultValue = result.value ?? "";
    throw new Error("apply boom");
  }
}

/** Kernel catalog. Live faces live on these records, not awareness lanes. */
@syncing("test:PewKernelRoot")
export class PewKernelRoot extends PlexusModel<null> implements KernelRootModel {
  @syncing.child.record accessor connections: Record<string, ConnectionSpec> = {};
  @syncing.child.record accessor drivers: Record<string, DriverSpec> = {};
}

@syncing("test:PewSessionRoot")
export class PewSessionRoot extends WorkContainer {
  /** PEW does not parent PEW; `walkWork` follows `.work`. */
  @syncing.child.list accessor declared: WorkExpectation[] = [];

  get work(): WorkExpectation[] {
    return this.declared;
  }
}

export type ActorScript = (actor: ScriptedActor) => void | Promise<void>;

export class ScriptedActor extends ExpectationActor {
  readonly #script: ActorScript | undefined;

  constructor(expectation: WorkExpectation, driverConnection: PEWDriver, script?: ActorScript) {
    super(expectation, driverConnection);
    this.#script = script;
  }

  protected run(): void | Promise<void> {
    return this.#script?.(this);
  }

  /** Test scripts sit outside the class; production actors keep these protected. */
  public override report(frame: TestReport): void {
    super.report(frame);
  }

  public override complete(result: TestResult): void {
    super.complete(result);
  }
}

/** Test double for bootstrap / resolve. Not a spawn authority. */
export class TestLoader {
  loadCalls = 0;
  spawnCalls = 0;
  failLoad: unknown = null;
  script: ActorScript | undefined;
  lastActor: ScriptedActor | null = null;
  onSpawn: (() => void) | null = null;

  constructor(script?: ActorScript) {
    this.script = script;
  }

  async load(): Promise<void> {
    this.loadCalls += 1;
    if (this.failLoad !== null) throw this.failLoad;
  }

  mintActor(expectation: WorkExpectation, driverConnection: PEWDriver): ScriptedActor {
    this.spawnCalls += 1;
    const actor = new ScriptedActor(expectation, driverConnection, this.script);
    this.lastActor = actor;
    this.onSpawn?.();
    return actor;
  }
}

export class ThrowingSpawnLoader extends TestLoader {
  override mintActor(_expectation: WorkExpectation, _connection: PEWDriver): ScriptedActor {
    this.spawnCalls += 1;
    throw new Error("spawn boom");
  }
}

/**
 * Always boots both planes as local Y.Docs — no wire, no hubless mode.
 *
 * Presence split: kernel root maps → driver / connection live faces;
 * kernel hub → connection/driver attention occupancy (interned across sessions);
 * session hub → actor report pens + author lanes.
 */
export class PewTestHost extends Orchestrator implements Disposable {
  readonly kernelRoot: PewKernelRoot;
  readonly sessionRoot: PewSessionRoot;
  readonly #ownsKernel: boolean;

  readonly awareness: PlexusAwareness;
  readonly loaders = new Map<object, TestLoader>();
  readonly #loadersByDriver = new Map<string, TestLoader>();
  readonly #driverConnectionClasses = new Map<string, DriverConnectionClass>();
  readonly #byId = new Map<string, TestCatalogRow>();

  constructor(shared?: { readonly kernel: KernelPlexus; readonly kernelRoot: PewKernelRoot }) {
    const kernelRoot = shared?.kernelRoot ?? new PewKernelRoot();
    const sessionRoot = new PewSessionRoot();
    // Plexus.bootstrap is not yet shape-generic — dual-doc PEW handles.
    const kernel = shared?.kernel ?? (Plexus.bootstrap(kernelRoot) as KernelPlexus);
    const session = Plexus.bootstrap(sessionRoot) as SessionPlexus;
    super(kernel, session);
    this.kernelRoot = kernelRoot;
    this.sessionRoot = sessionRoot;
    this.#ownsKernel = shared === undefined;
    this.awareness = this.session.awareness;
    this.activate();
  }

  /** Second session on the same kernel document — shared connection intern. */
  forkSession(): PewTestHost {
    const child = new PewTestHost({ kernel: this.kernel, kernelRoot: this.kernelRoot });
    for (const [name, loader] of this.#loadersByDriver) {
      child.#loadersByDriver.set(name, loader);
    }
    for (const [row, loader] of this.loaders) {
      child.loaders.set(row, loader);
    }
    for (const [name, cls] of this.#driverConnectionClasses) {
      child.#driverConnectionClasses.set(name, cls);
    }
    for (const [id, row] of this.#byId) {
      child.#byId.set(id, row);
    }
    return child;
  }

  [Symbol.dispose](): void {
    super[Symbol.dispose]();
    for (const node of walkWork(this.session.root)) {
      if (!(node instanceof WorkExpectation)) continue;
      this.actorOf(node)?.abort("host_dispose");
      this.connectionOf(node)?.release(node);
    }
    this.session.destroy();
    if (this.#ownsKernel) this.kernel.destroy();
  }

  /**
   * `id` is the catalog key expectations stamp.
   */
  register(
    idOrRow: string | { readonly name?: string; readonly importPath?: string },
    loader: TestLoader | null,
  ): string {
    const id = registerId(idOrRow);
    const importPath = registerImportPath(idOrRow, id);
    const driver =
      this.kernelRoot.drivers[id] ??
      new DriverSpec({
        name: id,
        description: "",
        importPath,
        abilityClaim: [],
        multiplicity: "add-as-secondary",
      });
    driver.name = id;
    driver.importPath = importPath;
    const row: TestCatalogRow = { id, name: id, driver, settings: {} };
    this.#byId.set(id, row);
    if (loader) {
      this.loaders.set(row, loader);
      this.#loadersByDriver.set(driver.name, loader);
    }
    this.kernelRoot.drivers[id] = driver;
    this.kernelRoot.connections[id] ??= new ConnectionSpec({ driver, name: id });
    return id;
  }

  #liveOf(id: string, kind: "driver" | "connection"): DriverSpec | ConnectionSpec | undefined {
    return kind === "driver" ? this.kernelRoot.drivers[id] : this.kernelRoot.connections[id];
  }

  #face(id: string, kind: "driver" | "connection"): TestCatalogFace {
    const liveOf = (): DriverSpec | ConnectionSpec | undefined => this.#liveOf(id, kind);
    return {
      id,
      name: id,
      get readyState() {
        return liveOf()?.readyState ?? null;
      },
      get error() {
        const live = liveOf();
        if (live == null || live.readyState === null) return null;
        return live.error === "" ? null : live.error;
      },
    };
  }

  /** Presence lives on the kernel root spec, not this wrapper. */
  catalogOf(connection: string | { readonly id?: string; readonly name?: string }): TestCatalogFace {
    const id = typeof connection === "string" ? connection : (connection.id ?? connection.name ?? "");
    const row = this.#byId.get(id);
    const driverId = row?.driver.name ?? id;
    return Object.assign(this.#face(id, "connection"), { driver: this.#face(driverId, "driver") });
  }

  get catalogDrivers(): TestCatalogFace[] {
    const names = new Set([...this.#byId.values()].map((row) => row.driver.name));
    return [...names].map((name) => this.#face(name, "driver"));
  }

  get catalogFaces(): TestCatalogFace[] {
    return [...this.#byId.keys()].map((id) => this.catalogOf(id));
  }

  mint(): TestExpectation;
  mint<E extends WorkExpectation>(entity: E): E;
  mint(entity?: WorkExpectation): WorkExpectation {
    if (entity === undefined) {
      const id = this.#byId.keys().next().value ?? this.register("test", null);
      entity = new TestExpectation({ connectionId: id });
    }
    this.sessionRoot.declared.push(entity);
    return entity;
  }

  async loadDriverModule(driver: DriverSpec): Promise<DriverConnectionClass> {
    const loader = this.#loadersByDriver.get(driver.name);
    invariant(loader != null, `PewTestHost.loadDriverModule: no loader for ${driver.importPath}`);
    let cls = this.#driverConnectionClasses.get(driver.name);
    if (cls === undefined) {
      cls = pewDriverConnectionClassFromLoader(loader);
      this.#driverConnectionClasses.set(driver.name, cls);
    }
    return cls;
  }
}

export function makeHost(
  script?: ActorScript,
  options: { connectionId?: string } = {},
): {
  host: PewTestHost;
  loader: TestLoader;
  connection: { readonly id: string; readonly name: string };
  connectionId: string;
  [Symbol.dispose](): void;
} {
  const host = new PewTestHost();
  const loader = new TestLoader(script);
  const connectionId = host.register(options.connectionId ?? "test", loader);
  return {
    host,
    loader,
    connection: { id: connectionId, name: connectionId },
    connectionId,
    [Symbol.dispose]() {
      host[Symbol.dispose]();
    },
  };
}

function catalogFacesFailed(host: PewTestHost, expectation: WorkExpectation): boolean {
  const row = host.catalogOf(expectation.connectionId);
  if (row.readyState === "failed") return true;
  if (row.driver?.readyState === "failed") return true;
  return false;
}

/** Wait on public faces: worker, done, or catalog ensure failed. */
export async function activateThroughLoad(host: PewTestHost, expectation: WorkExpectation): Promise<void> {
  await when(() => expectation.workerPresent || expectation.isDone || catalogFacesFailed(host, expectation));
  await Promise.resolve();
  await Promise.resolve();
}

function registerId(idOrRow: string | { readonly name?: string; readonly importPath?: string }): string {
  if (typeof idOrRow === "string") return idOrRow;
  if (idOrRow.name && idOrRow.name !== "") return idOrRow.name;
  return `test:${crypto.randomUUID()}`;
}

function registerImportPath(
  idOrRow: string | { readonly name?: string; readonly importPath?: string },
  id: string,
): string {
  if (typeof idOrRow === "string") return `test:${id}`;
  if (idOrRow.importPath && idOrRow.importPath !== "") return idOrRow.importPath;
  return `test:${id}`;
}

function pewDriverConnectionClassFromLoader(loader: TestLoader): DriverConnectionClass {
  return class extends PEWDriver {
    async bootstrap(): Promise<void> {
      await loader.load();
    }

    protected resolve(expectation: WorkExpectation): ExpectationActor<any> {
      return loader.mintActor(expectation, this);
    }
  };
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A remote author: own Y.Doc, own awareness, synced onto the worker hub.
 * Plexus: not createLocalClient — that would be a second pen on the same map.
 */
export function connectAuthor(hub: PlexusAwareness): {
  author: PlexusAwareness;
  sync: () => void;
  [Symbol.dispose](): void;
} {
  const doc = new Y.Doc();
  const author = new PlexusAwareness(doc);
  const sync = (): void => {
    const clients = [...author.meta.keys()];
    if (clients.length === 0) return;
    applyAwarenessUpdate(hub, encodeAwarenessUpdate(author, clients), "remote");
  };
  return {
    author,
    sync,
    [Symbol.dispose]() {
      author.destroy();
      doc.destroy();
    },
  };
}
