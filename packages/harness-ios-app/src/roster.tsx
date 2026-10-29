import { useDial } from "./dial-context.js";
import { isListed, projectStatus, type Glance } from "./directory.js";
import { rowLight, type RowLight } from "../../harness-web-app/src/shell/light.js";
import { projectNames } from "../../harness-web-app/src/shell/path.js";

/**
 * Read during render from an `observer`. The kernel, the project rooms, and the
 * open session are the lists.
 */
export function useWorkspace() {
  const dial = useDial();
  const kernel = dial.kernel;
  const paths = Object.keys(kernel?.root.projects ?? {});
  const names = projectNames(paths);
  const glance = (sessionId: string): Glance | undefined => kernel?.root.sessions[sessionId];
  const held = (path: string) => dial.projects.get(path) ?? (dial.project?.root.path === path ? dial.project : null);
  const lightFor = (sessionId: string): RowLight =>
    rowLight(dial.session?.root.sessionId === sessionId ? dial.session.root : null, kernel?.root.sessions[sessionId]);
  const conversationIds = (path: string): string[] => {
    const room = held(path);
    if (room == null) return [];
    return Object.keys(room.root.sessions).filter((sessionId) => isListed(kernel?.root.sessions[sessionId]));
  };
  const statusFor = (path: string) => projectStatus(Object.keys(held(path)?.root.sessions ?? {}).map(lightFor));
  return { dial, kernel, paths, names, glance, held, lightFor, conversationIds, statusFor };
}
