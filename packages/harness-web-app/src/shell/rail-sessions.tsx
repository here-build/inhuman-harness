import { useEffect, useState } from "react";
import { isConversationOverview, type SessionOverview, type SessionRoot } from "@inhuman.tools/harness-model";
import type { ProjectPlexus } from "@inhuman.tools/harness-peer";
import { IconPlus } from "@tabler/icons-react";
import { observer } from "mobx-react-lite";

import { rowLight, type RowLight } from "./light.js";
import { LinkNotice } from "./link-notice.js";
import { looseSessionHref, projectNames, sessionHref } from "./path.js";
import { orderSessions, overviewList, shortAge } from "./session-order.js";
import { NEW_CONVERSATION, rowTitle } from "./tape-read.js";
import { useDial } from "../client/context.js";
import { glyph } from "../components/ui/glyph.js";

export { orderSessions, OVERVIEW_RECENT_CAP, overviewList, shortAge } from "./session-order.js";

const rowClass =
  "touch-target flex min-h-8 w-full items-center gap-2 rounded-sm px-3 py-1 text-left text-sm hover:bg-hover focus-visible:outline-offset-0 aria-[current=page]:bg-selected aria-[current=page]:font-strong";

const filterClass =
  "h-9 w-full rounded-sm border border-edge bg-field px-3 py-1 text-sm text-ink placeholder:text-subtle";

export const SessionRail = observer(function SessionRailView({
  go,
  pane,
  selectedSessionId,
  onMint,
}: {
  readonly go: (href: string) => void;
  readonly pane:
    { readonly kind: "overview" } | { readonly kind: "project"; readonly path: string } | { readonly kind: "bots" };
  readonly selectedSessionId: string | null;
  readonly onMint: (path: string) => void;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  if (kernel == null) {
    const opening =
      dial.attaching && (dial.requestedTarget.kind === "session" || dial.requestedTarget.kind === "project-session");
    return (
      <nav className="px-4 py-4" aria-label="All projects" aria-busy="true">
        {opening ? (
          <p className="text-sm text-muted" role="status">
            Opening this session…
          </p>
        ) : null}
      </nav>
    );
  }
  if (pane.kind === "bots") return <BotList go={go} selectedSessionId={selectedSessionId} />;
  if (pane.kind === "overview") return <OverviewSessions go={go} selectedSessionId={selectedSessionId} />;
  return <ProjectSessions path={pane.path} go={go} selectedSessionId={selectedSessionId} onMint={onMint} />;
});

const OverviewSessions = observer(function OverviewSessionsView({
  go,
  selectedSessionId,
}: {
  readonly go: (href: string) => void;
  readonly selectedSessionId: string | null;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  const [query, setQuery] = useState("");
  if (kernel == null) return null;
  const paths = Object.keys(kernel.root.projects);
  const names = projectNames(paths);
  const heldOf = (path: string) => dial.projects.get(path) ?? (dial.project?.root.path === path ? dial.project : null);
  const rows: { sessionId: string; path: string; project: string }[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const held = heldOf(path);
    if (held == null) continue;
    const project = names.get(path) ?? path;
    for (const sessionId of Object.keys(held.root.sessions)) {
      if (seen.has(sessionId)) continue;
      if (!listedConversation(kernel.root.sessions[sessionId], sessionId === selectedSessionId)) continue;
      seen.add(sessionId);
      rows.push({ sessionId, path, project });
    }
  }
  const byId = new Map(rows.map((row) => [row.sessionId, row]));
  const lights = new Map(rows.map((row) => [row.sessionId, lightOf(dial, kernel, row.sessionId)]));
  const ordered = overviewList(
    rows.map((row) => row.sessionId),
    (id) => lights.get(id) ?? "idle",
    (id) => lastMessageAt(kernel.root.sessions[id]),
  );
  const needsAttention = ordered.some((id) => {
    const light = lights.get(id);
    return light === "waiting-for-you" || light === "running";
  });
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ""
      ? ordered
      : ordered.filter((id) => {
          const row = byId.get(id);
          return (
            labelOf(dial, kernel, id).toLowerCase().includes(needle) ||
            (row?.project.toLowerCase().includes(needle) ?? false)
          );
        });
  const heldAny = paths.some((path) => heldOf(path) != null);
  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label="All projects">
      {ordered.length === 0 ? (
        <p className="px-4 py-4 text-sm text-subtle" role="status">
          {paths.length === 0 ? "No projects yet." : heldAny ? "No sessions yet." : "Attaching…"}
        </p>
      ) : (
        <>
          <header className="flex min-h-12 shrink-0 items-center px-4 py-3">
            <h2 className="text-base">{needsAttention ? "Needs attention" : "Recent"}</h2>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
            {ordered.length > 8 ? (
              <input
                type="search"
                aria-label="Filter sessions"
                className={filterClass}
                placeholder="Filter"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            ) : null}
            {shown.length === 0 ? (
              <p className="px-3 py-1 text-sm text-subtle">No sessions match.</p>
            ) : (
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {shown.map((sessionId) => {
                  const row = byId.get(sessionId);
                  if (row == null) return null;
                  return (
                    <SessionRow
                      key={sessionId}
                      sessionId={sessionId}
                      selected={selectedSessionId === sessionId}
                      href={sessionHref(row.path, sessionId)}
                      go={go}
                      attached={dial.session?.root.sessionId === sessionId ? dial.session.root : null}
                      overview={kernel.root.sessions[sessionId]}
                      project={row.project}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </nav>
  );
});

const ProjectSessions = observer(function ProjectSessionsView({
  path,
  go,
  selectedSessionId,
  onMint,
}: {
  readonly path: string;
  readonly go: (href: string) => void;
  readonly selectedSessionId: string | null;
  readonly onMint: (path: string) => void;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  if (kernel == null) return null;
  const name = projectNames(Object.keys(kernel.root.projects)).get(path) ?? path;
  const held = dial.projects.get(path) ?? (dial.project?.root.path === path ? dial.project : null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    setQuery("");
  }, [path]);
  const sessions = held == null ? [] : listedSessions(kernel.root.sessions, held, selectedSessionId);
  const lights = new Map(sessions.map((id) => [id, lightOf(dial, kernel, id)]));
  const ordered = orderSessions(
    sessions,
    (id) => lights.get(id) ?? "idle",
    (id) => lastMessageAt(kernel.root.sessions[id]),
  );
  const needle = query.trim().toLowerCase();
  const shown =
    needle === "" ? ordered : ordered.filter((id) => labelOf(dial, kernel, id).toLowerCase().includes(needle));
  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label="All projects">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 px-4 py-3">
        <h2 className="min-w-0 truncate text-base" title={path}>
          {name}
        </h2>
        <button
          type="button"
          className="touch-target grid size-7 shrink-0 place-items-center rounded-xs text-muted hover:bg-hover hover:text-ink"
          aria-label={`New session in ${name}`}
          disabled={held == null}
          onClick={() => onMint(path)}
        >
          <IconPlus {...glyph} aria-hidden />
        </button>
      </header>
      {dial.session == null && dial.link != null ? <LinkNotice /> : null}
      {held == null ? (
        <p className="px-4 py-2 text-sm text-subtle" role="status">
          {dial.requestedTarget.kind === "session" || dial.requestedTarget.kind === "project-session"
            ? "Opening this session…"
            : "Attaching…"}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
          {sessions.length > 8 ? (
            <input
              type="search"
              aria-label="Filter sessions"
              className={filterClass}
              placeholder="Filter"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {sessions.length === 0 ? (
            <p className="px-3 py-1 text-sm text-subtle">No sessions yet.</p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-1 text-sm text-subtle">No sessions match.</p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {shown.map((sessionId) => (
                <SessionRow
                  key={sessionId}
                  sessionId={sessionId}
                  selected={selectedSessionId === sessionId}
                  href={sessionHref(path, sessionId)}
                  go={go}
                  attached={dial.session?.root.sessionId === sessionId ? dial.session.root : null}
                  overview={kernel.root.sessions[sessionId]}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </nav>
  );
});

const BotList = observer(function BotListView({
  go,
  selectedSessionId,
}: {
  readonly go: (href: string) => void;
  readonly selectedSessionId: string | null;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  if (kernel == null) return null;
  const projects = Object.keys(kernel.root.projects);
  const names = projectNames(projects);
  const held = (path: string) => dial.projects.get(path) ?? (dial.project?.root.path === path ? dial.project : null);
  const groups = [
    { key: "", name: "Global", bots: Object.entries(kernel.root.botsRoster), href: looseSessionHref },
    ...projects.map((path) => ({
      key: path,
      name: names.get(path) ?? path,
      bots: Object.entries(held(path)?.root.botsRoster ?? {}),
      href: (sessionId: string) => sessionHref(path, sessionId),
    })),
  ].filter((group) => group.bots.length > 0);
  const light = (sessionId: string) =>
    rowLight(dial.session?.root.sessionId === sessionId ? dial.session.root : null, kernel.root.sessions[sessionId]);
  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label="All projects">
      <header className="flex min-h-12 shrink-0 items-center px-4 py-3">
        <h2 className="text-base">Bots</h2>
      </header>
      {groups.length === 0 ? (
        <p className="px-4 py-2 text-sm text-subtle">No bots.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {groups.map((group) => (
            <li key={group.key}>
              <p className="truncate px-3 py-1 text-sm font-strong text-muted" title={group.key || undefined}>
                {group.name}
              </p>
              <ul>
                {group.bots.map(([name, sessionId]) => (
                  <RailRow
                    key={name}
                    href={group.href(sessionId)}
                    go={go}
                    label={name}
                    light={light(sessionId)}
                    selected={selectedSessionId === sessionId}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
});

function listedConversation(overview: SessionOverview | undefined, force: boolean): boolean {
  if (force) return true;
  if (overview == null || !isConversationOverview(overview)) return false;
  return (
    rowText(overview.title).trim() !== "" ||
    rowText(overview.status).trim() !== "" ||
    rowText(overview.lastPrompt).trim() !== ""
  );
}

function listedSessions(
  glances: { readonly [id: string]: SessionOverview | undefined },
  held: ProjectPlexus,
  selectedSessionId: string | null,
): string[] {
  return Object.keys(held.root.sessions).filter((sessionId) => {
    if (sessionId === selectedSessionId) return true;
    if (!Object.hasOwn(glances, sessionId)) return false;
    const overview = glances[sessionId];
    if (overview == null || !isConversationOverview(overview)) return false;
    const title = rowText(overview.title);
    const status = rowText(overview.status);
    return title.trim() !== "" || status.trim() !== "";
  });
}

function lightOf(
  dial: ReturnType<typeof useDial>,
  kernel: NonNullable<ReturnType<typeof useDial>["kernel"]>,
  sessionId: string,
): RowLight {
  return rowLight(
    dial.session?.root.sessionId === sessionId ? dial.session.root : null,
    kernel.root.sessions[sessionId],
  );
}

function labelOf(
  dial: ReturnType<typeof useDial>,
  kernel: NonNullable<ReturnType<typeof useDial>["kernel"]> | null,
  sessionId: string,
): string {
  const overview = kernel?.root.sessions[sessionId];
  const attached = dial.session?.root.sessionId === sessionId ? dial.session.root : null;
  return rowTitle({
    live: attached?.title ?? "",
    title: overview?.title ?? "",
    lastPrompt: overview?.lastPrompt ?? "",
  });
}

function SessionRow({
  sessionId,
  selected,
  href,
  go,
  attached,
  overview,
  project,
}: {
  readonly sessionId: string;
  readonly selected: boolean;
  readonly href: string;
  readonly go: (href: string) => void;
  readonly attached: SessionRoot | null;
  readonly overview: SessionOverview | undefined;
  readonly project?: string;
}) {
  const label = rowTitle({
    live: attached?.title ?? "",
    title: overview?.title ?? "",
    lastPrompt: overview?.lastPrompt ?? "",
  });
  const age = shortAge(overview?.lastMessageAt, Date.now());
  return (
    <RailRow
      href={href}
      go={go}
      label={label}
      light={rowLight(attached, overview)}
      selected={selected}
      title={label === NEW_CONVERSATION ? sessionId : label}
      age={age}
      detail={project}
    />
  );
}

function RailRow({
  href,
  go,
  label,
  light,
  selected,
  title = label,
  age = "",
  detail = "",
}: {
  readonly href: string;
  readonly go: (href: string) => void;
  readonly label: string;
  readonly light: RowLight;
  readonly selected: boolean;
  readonly title?: string;
  readonly age?: string;
  readonly detail?: string;
}) {
  return (
    <li>
      <a
        className={rowClass}
        href={href}
        aria-current={selected ? "page" : undefined}
        title={detail === "" ? title : `${title} — ${detail}`}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          go(href);
        }}
      >
        <Light light={light} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {detail === "" ? null : <span className="max-w-32 shrink-0 truncate text-muted">{detail}</span>}
        {age === "" ? null : <time className="shrink-0 text-xs tabular-nums text-subtle">{age}</time>}
      </a>
    </li>
  );
}

function rowText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** No message yet means just minted: newest of its band. */
function lastMessageAt(overview: SessionOverview | undefined): number {
  return overview?.lastMessageAt ?? Number.POSITIVE_INFINITY;
}

function Light({ light }: { readonly light: RowLight }) {
  if (light === "idle") return <span aria-hidden className="size-2 shrink-0" />;
  return (
    <span
      role="img"
      aria-label={light === "waiting-for-you" ? "waiting for you" : light}
      className={`inline-block size-2 shrink-0 rounded-xs ${light === "running" ? "bg-success" : "border-2 border-warning"}`}
    />
  );
}
