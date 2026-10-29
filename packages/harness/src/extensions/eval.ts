import { exec, LexicalScope, parse, type ExecOptions } from "@here.build/arrival";

import { behaviorAls, behaviorCapability, behaviorPrelude, stampForms } from "./behavior.js";
import { jsToVal, unwrapBehaviorError, valToScheme } from "./crossing.js";
import { PluginSurfaceError } from "./surface-error.js";
import { Dict, Lambda, emptyRegistry, type Ctx, type Mode, type Proc, type Registry, type Val } from "./value.js";

export type LoadOptions = {
  readonly agentId: string;
  readonly source: string;
  readonly filename: string;
  readonly revision: string;
  readonly root: string;
  readonly read: (path: string) => string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly kind: "behavior" | "state";
  readonly environment?: ReadonlyMap<string, Proc>;
};

export function configDict(raw: Readonly<Record<string, unknown>> | undefined): Dict {
  const value = jsonToVal(raw ?? {});
  return value instanceof Dict ? value : new Dict({});
}

/** JSON data as a behavior value. `null` is `#f`. */
export function jsonToVal(raw: unknown): Val {
  if (raw == null) return false;
  if (typeof raw === "boolean" || typeof raw === "number" || typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) return raw.map((entry) => jsonToVal(entry));
  PluginSurfaceError.invariant(typeof raw === "object", "value must be JSON data");
  const entries: Record<string, Val> = {};
  for (const [key, value] of Object.entries(raw)) {
    entries[key] = jsonToVal(value);
  }
  return new Dict(entries);
}

export function makeCtx(opts: {
  readonly mode: Mode;
  readonly agentId: string;
  readonly sourceText: string;
  readonly file: string;
  readonly root: string;
  readonly read: (path: string) => string;
  readonly config: Dict;
  readonly registry: Registry;
  readonly environment?: ReadonlyMap<string, Proc>;
}): Ctx {
  return {
    mode: opts.mode,
    agentId: opts.agentId,
    sourceText: opts.sourceText,
    file: opts.file,
    root: opts.root,
    read: opts.read,
    config: opts.config,
    proposals: null,
    hostAuthority: false,
    lineage: [],
    notify: null,
    onMethod: null,
    admit: null,
    replay: false,
    recorded: new Map(),
    invocationId: "",
    deliveries: [],
    originAtoms: [],
    environment: opts.environment ?? new Map(),
    cancelled: false,
    boundary: "",
    retryable: true,
    registry: opts.registry,
  };
}

export async function loadProgram(opts: LoadOptions): Promise<Registry> {
  const config = configDict(opts.config);
  const registry = emptyRegistry(opts.agentId, opts.revision, config);
  const ctx = makeCtx({
    mode: "register",
    agentId: opts.agentId,
    sourceText: opts.source,
    file: opts.filename,
    root: opts.root,
    read: opts.read,
    config,
    registry,
    environment: opts.environment,
  });
  if (opts.environment != null) {
    for (const [name, proc] of opts.environment) {
      registry.environment.set(name, proc);
    }
  }
  registry.loaded.set(opts.filename, opts.source);
  const scope = LexicalScope.fresh("behavior");
  const capabilities = [behaviorCapability];
  try {
    await behaviorAls.run(ctx, async () => {
      await exec(behaviorPrelude([...registry.environment.keys()]), {
        capabilities,
        scope,
      });
      const forms = await parse(opts.source, opts.filename);
      stampForms(forms, opts.source);
      await exec("", {
        capabilities,
        scope,
        program: {
          forms,
          source: opts.source,
          strict: false,
        } as ExecOptions["program"],
      });
    });
  } catch (error) {
    throw unwrapBehaviorError(error);
  }
  PluginSurfaceError.invariant(
    opts.kind !== "state" ||
      (!(registry.tools.size > 0 || registry.guards.length > 0 || registry.hooks.length > 0) &&
        registry.reducer != null),
    () =>
      registry.tools.size > 0 || registry.guards.length > 0 || registry.hooks.length > 0
        ? "state module cannot register tools, guards, or hooks"
        : "state module requires one reducer",
  );
  PluginSurfaceError.invariant(
    handlerSources(registry).every((source) => !source.includes("JSON.parse")),
    "JSON.parse is host schema repair, not a plugin",
  );
  return registry;
}

export async function applyLambda(lambda: Lambda, args: readonly Val[], ctx: Ctx): Promise<Val> {
  try {
    const result = await behaviorAls.run(ctx, () => lambda.call(...args.map((arg) => valToScheme(arg))));
    return jsToVal(result);
  } catch (error) {
    throw unwrapBehaviorError(error);
  }
}

function handlerSources(registry: Registry): string[] {
  return [
    ...[...registry.tools.values()].map((tool) => tool.handler.source),
    ...registry.guards.map((guard) => guard.source),
    ...registry.hooks.flatMap((hook) => [hook.pre?.source, hook.post?.source, hook.postFail?.source]),
    registry.reducer?.initial.source,
    registry.reducer?.reduce.source,
    registry.reducer?.hostOnly?.source,
    ...[...registry.methods.values()].map((method) => method.handler.source),
  ].filter((source): source is string => source != null);
}
