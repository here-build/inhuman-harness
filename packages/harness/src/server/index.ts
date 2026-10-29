/** Light client facade: start/stop, plugin install, and the process log path. Does not import executable composition. */
export { installPlugin, type InstallStreams } from "../extensions/install.js";
export { daemonRunning as daemonRunning, ensure as ensure, stop as stop } from "./ensure.js";
export * from "./step.js";
