import {
  attentionKind,
  attentionSections,
  attentionTone,
  type AttentionKind,
  type ConnectionFace,
  type WaitingSection,
} from "./directory.js";
import { useWorkspace } from "./roster.js";

export type Attention = {
  readonly sections: readonly WaitingSection[];
  readonly count: number;
  readonly tone: "yellow" | "red" | "clear";
  kindFor(sessionId: string): AttentionKind | null;
};

/** Decisions and failures. A path limits the sheet to that project; null is the whole workspace. */
export function useAttention(onlyPath: string | null): Attention {
  const { kernel, paths, names, held } = useWorkspace();
  const connections = kernel?.root.connections as Readonly<Record<string, ConnectionFace | undefined>> | undefined;
  const kindFor = (sessionId: string): AttentionKind | null =>
    attentionKind(kernel?.root.sessions[sessionId], connections);
  const source = onlyPath == null ? paths : paths.filter((path) => path === onlyPath);
  const projects = source.map((path) => ({
    path,
    name: names.get(path) ?? path,
    sessionIds: [
      ...new Set([
        ...Object.keys(held(path)?.root.sessions ?? {}),
        ...Object.values(held(path)?.root.botsRoster ?? {}),
      ]),
    ],
  }));
  const loose = onlyPath == null ? Object.values(kernel?.root.botsRoster ?? {}) : [];
  const sections = attentionSections(projects, loose, kindFor, (id) => {
    return kernel?.root.sessions[id]?.lastMessageAt ?? Number.POSITIVE_INFINITY;
  });
  const ids = [...new Set(sections.flatMap((section) => section.sessionIds))];
  const kinds = ids.flatMap((id) => {
    const kind = kindFor(id);
    return kind == null ? [] : [kind];
  });
  return { sections, count: ids.length, tone: attentionTone(kinds), kindFor };
}
