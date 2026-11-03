import { makeFsLoader, type Loader } from "@here.build/arrival-modules";

export type ResourceIdentity = {
  readonly id: string;
  readonly revision: string;
};

export type ModuleBundle = ResourceIdentity & {
  readonly loader: Loader;
};

export type ModuleBundleInput = ResourceIdentity & {
  readonly modules: Readonly<Record<string, string>>;
};

/** Pins each resolved read, including failures; the host may persist it before evaluation proceeds. */
export function pinModuleLoader(
  loader: Loader,
  capture?: (path: string, content: string) => void | Promise<void>,
): Loader {
  const reads = new Map<string, Promise<string>>();
  return {
    resolve: (specifier, fromDir) => loader.resolve(specifier, fromDir),
    read(path) {
      let read = reads.get(path);
      if (read === undefined) {
        read = Promise.resolve()
          .then(() => loader.read(path))
          .then(async (content) => {
            const text = typeof content === "string" ? content : new TextDecoder().decode(content);
            await capture?.(path, text);
            return text;
          });
        reads.set(path, read);
      }
      return read;
    },
    resolvers: loader.resolvers,
  };
}

function moduleKey(path: string): string {
  if (path.startsWith("/") || /[\\\0]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error(`module is outside the resource namespace: ${path}`);
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new Error(`module escapes the resource namespace: ${path}`);
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  if (segments.length === 0) throw new Error("module key is empty");
  return segments.join("/");
}

/** Captures content once; nested imports can only read this bundle's normalized keys. */
export function createModuleBundle(input: ModuleBundleInput): ModuleBundle {
  if (input.id.trim() === "" || input.revision.trim() === "") {
    throw new Error("a module bundle requires an identity and revision");
  }
  const modules = new Map<string, string>();
  for (const [path, content] of Object.entries(input.modules)) {
    const key = moduleKey(path);
    if (modules.has(key)) throw new Error(`duplicate normalized module: ${key}`);
    modules.set(key, content);
  }
  const base = makeFsLoader({
    readFile(path) {
      const key = moduleKey(path);
      const content = modules.get(key);
      if (content === undefined) throw new Error(`module unavailable in ${input.id}@${input.revision}: ${key}`);
      return content;
    },
  });
  const loader: Loader = {
    resolve(specifier, fromDir) {
      if (specifier.startsWith("/") || /[\\\0]/.test(specifier) || /^[a-z][a-z\d+.-]*:/i.test(specifier)) {
        throw new Error(`module is outside the resource namespace: ${specifier}`);
      }
      return base.resolve(specifier, fromDir);
    },
    read: (path) => base.read(path),
    resolvers: base.resolvers,
  };
  return Object.freeze({ id: input.id, revision: input.revision, loader });
}
