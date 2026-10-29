const fs = require("node:fs");
const path = require("node:path");

const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

/** One copy. A second MobX or Yjs makes the dial's observers blind. */
const SINGLETONS = new Set([
  "react",
  "react-native",
  "mobx",
  "mobx-react-lite",
  "yjs",
  "y-websocket",
  "@here.build/plexus",
  "@inhuman.tools/harness-model",
  // Babel injects helper imports into every compiled file. Those files live
  // outside this package, so the helper has to resolve from here.
  "@babel/runtime",
]);

/**
 * @param {string} specifier
 * @returns {string | null}
 */
function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return name == null ? null : `${scope}/${name}`;
  }
  const name = specifier.split("/")[0];
  return name == null || name === "" ? null : name;
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function existing(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

/**
 * The web sources say `.js` for a `.ts` file.
 * @param {string} specifier
 * @param {string} origin
 * @returns {string | null}
 */
function sourceFile(specifier, origin) {
  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) return null;
  const stem = path.resolve(path.dirname(origin), specifier).slice(0, -3);
  return existing(`${stem}.ts`) ?? existing(`${stem}.tsx`) ?? existing(`${stem}.js`) ?? existing(`${stem}.mjs`);
}

const websocketSource = path.join(projectRoot, "node_modules/y-websocket/src/y-websocket.js");

/** Arrival's subpath exports use conditions Metro does not select. */
function arrivalSubpath(specifier) {
  const prefix = "@here.build/arrival/";
  if (!specifier.startsWith(prefix)) return null;
  const root = path.join(workspaceRoot, "packages/harness-web-app/node_modules/@here.build/arrival");
  const name = specifier.slice(prefix.length);
  return existing(path.join(root, "dist", name, "index.js")) ?? existing(path.join(root, "dist", `${name}.js`));
}

/** lib0's react-native export needs isomorphic-webcrypto. Hermes already has `crypto`. */
function browserWebcrypto() {
  const yjsDir = fs.realpathSync(path.join(projectRoot, "node_modules/yjs"));
  const file = path.join(yjsDir, "..", "lib0", "webcrypto.js");
  if (!fs.existsSync(file)) throw new Error("lib0/webcrypto.js is not installed.");
  return file;
}

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
    // `import` before `default` would load Babel's ESM helpers. Those helpers are
    // called as functions (`require("@babel/runtime/helpers/…")()`), so the CJS
    // build is the one that runs. y-websocket is pinned to its browser source below.
    unstable_conditionNames: ["react-native", "browser", "require", "default"],
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName === "y-websocket" && fs.existsSync(websocketSource)) {
        return context.resolveRequest(context, websocketSource, platform);
      }
      const arrival = arrivalSubpath(moduleName);
      if (arrival != null) return context.resolveRequest(context, arrival, platform);
      if (moduleName === "lib0/webcrypto" || moduleName === "lib0/webcrypto.js") {
        return context.resolveRequest(context, browserWebcrypto(), platform);
      }
      const file = sourceFile(moduleName, context.originModulePath);
      if (file != null) return context.resolveRequest(context, file, platform);
      const name = packageName(moduleName);
      if (name != null && SINGLETONS.has(name)) {
        return context.resolveRequest(
          { ...context, originModulePath: path.join(projectRoot, "index.js") },
          moduleName,
          platform,
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
