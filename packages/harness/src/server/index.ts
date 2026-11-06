/** Light client facade: start/stop, loopback web server, plugin install, and the process log path. Does not import executable composition. */
export { installPlugin, type InstallStreams } from "../extensions/install.js";
export { daemonRunning as daemonRunning, ensure as ensure, stop as stop } from "./ensure.js";
export {
  fileInsideRoots,
  listenWebApp,
  originAllowed,
  type ListenWebAppOptions,
  type WebAppServer,
} from "./listen.js";
export * from "./step.js";
export * from "./web-door.js";
