import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { IconSettings } from "@tabler/icons-react";
import { Outlet, useRouter } from "@tanstack/react-router";
import { observer } from "mobx-react-lite";

import { AddProjectDialog } from "./add-project.js";
import { Composer } from "./composer.js";
import { readEmbed } from "./embed.js";
import { FilePreviewPane, FilePreviewProvider } from "./file-sidebar.js";
import { LinkNotice } from "./link-notice.js";
import { focusStage } from "./new-session.js";
import { projectHref } from "./path.js";
import { botIdsOf, ProjectTabs, railPane } from "./project-tabs.js";
import { needsOnboarding } from "./provider-list.js";
import { SessionRail } from "./rail-sessions.js";
import { SettingsDialog } from "./settings.js";
import { Splash } from "./splash.js";
import { useDial } from "../client/context.js";
import { appLocation } from "../client/location.js";
import { Button } from "../components/ui/button.js";
import { glyph } from "../components/ui/glyph.js";

const remote = appLocation(globalThis.location).remote;

export const Frame = observer(function Shell() {
  const dial = useDial();
  const router = useRouter();
  const [railOpen, setRailOpen] = useState(false);
  const [browsingBots, setBrowsingBots] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const routed = dial.requestedTarget;
  const committed = dial.target;
  const targetPath =
    committed.kind === "project" || committed.kind === "project-session"
      ? committed.path
      : (dial.project?.root.path ?? null);
  const sessionId = routed.kind === "session" || routed.kind === "project-session" ? routed.sessionId : null;
  const attached = sessionId != null && dial.session?.root.sessionId === sessionId ? dial.session.root : null;
  const scrollport = useRef<HTMLElement>(null);
  const attachedId = attached?.sessionId;
  useLayoutEffect(() => {
    // Establish the tail once on attach. Native anchoring owns subsequent
    // streaming updates, so reading earlier history never forces a jump.
    const port = scrollport.current;
    if (attachedId != null && port != null) port.scrollTop = port.scrollHeight;
  }, [attachedId]);
  const routeKey = `${routed.kind}:${"path" in routed ? routed.path : ""}:${"sessionId" in routed ? routed.sessionId : ""}`;
  useEffect(() => {
    setBrowsingBots(false);
  }, [routeKey]);
  const go = (href: string): void => {
    setRailOpen(false);
    setBrowsingBots(false);
    void router.navigate({ href });
  };
  const openStage = (path: string): void => {
    focusStage();
    go(projectHref(path));
  };

  const embed = readEmbed(typeof window === "undefined" ? "" : window.location.search);
  if (embed.active) {
    const inset = {
      "--embed-safe-top": `${embed.safeTop}px`,
      "--embed-safe-bottom": `${embed.safeBottom}px`,
    } as CSSProperties;
    return (
      <FilePreviewProvider resetKey={sessionId}>
        <div className="frame" data-embed="" style={inset}>
          <main ref={scrollport} className="tape" aria-label="Conversation">
            {sessionId != null && attached == null ? (
              <div className="transcript">
                <section className="transcript-empty transcript-column">
                  <LinkNotice />
                </section>
              </div>
            ) : (
              <Outlet />
            )}
            <div className="anchor" />
          </main>
          <FilePreviewPane projectPath={attached?.path ?? targetPath ?? ""} />
        </div>
      </FilePreviewProvider>
    );
  }

  if (dial.kernel != null && needsOnboarding(dial.kernel.root.connections)) return <Splash />;

  const bots = dial.kernel == null ? new Set<string>() : botIdsOf(dial.kernel, dial.projects);
  const pane = railPane(routed, bots, browsingBots);

  return (
    <FilePreviewProvider resetKey={sessionId}>
      <div className="frame">
        <div className="frame-body">
          <aside
            id="navigation-rail"
            aria-label="Projects and sessions"
            className={`rail w-full shrink-0 flex-col overflow-y-auto bg-wash max-[63.999rem]:max-h-[70dvh] min-[64rem]:w-72 min-[64rem]:max-h-none min-[64rem]:overflow-hidden min-[64rem]:border-r min-[64rem]:border-line ${railOpen ? "flex max-[63.999rem]:border-b max-[63.999rem]:border-line" : "hidden min-[64rem]:flex"}`}
          >
            <h1 className="rail-brand">Inhuman</h1>
            {remote ? (
              <a className="rail-machines" href="/">
                All machines
              </a>
            ) : null}
            <div className="flex flex-col min-[64rem]:min-h-0 min-[64rem]:flex-1">
              <SessionRail go={go} pane={pane} selectedSessionId={sessionId} onMint={openStage} />
            </div>
          </aside>
          <main ref={scrollport} className="tape" aria-label="Conversation">
            <Outlet />
            <div className="anchor" />
            <Composer />
          </main>
          <FilePreviewPane projectPath={attached?.path ?? targetPath ?? ""} />
        </div>
        <div className="project-strip">
          <button type="button" className="project-corner touch-target" onClick={() => setSettingsOpen(true)}>
            <IconSettings {...glyph} aria-hidden />
            Settings
          </button>
          <Button
            variant="ghost"
            className="min-[64rem]:hidden"
            aria-label={railOpen ? "Close navigation" : "Open navigation"}
            aria-controls="navigation-rail"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((open) => !open)}
          >
            {railOpen ? "Close" : "Browse"}
          </Button>
          <ProjectTabs
            go={go}
            pane={pane}
            onBrowseBots={() => {
              setBrowsingBots(true);
              setRailOpen(true);
            }}
            onAdd={() => setAdding(true)}
            onMint={openStage}
          />
        </div>
        {adding ? <AddProjectDialog onDismiss={() => setAdding(false)} /> : null}
        {settingsOpen ? <SettingsDialog onDismiss={() => setSettingsOpen(false)} /> : null}
      </div>
    </FilePreviewProvider>
  );
});
