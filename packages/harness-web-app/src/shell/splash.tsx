import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconArrowRight } from "@tabler/icons-react";
import { observer } from "mobx-react-lite";

import { ConnectStep, connectPort } from "./connect-step.js";
import { LinkNotice } from "./link-notice.js";
import {
  GROUP_LABELS,
  providerRows,
  type ConnectStart,
  type ProviderGroup,
  type ProviderRow,
} from "./provider-list.js";
import { useDial } from "../client/context.js";
import { glyph } from "../components/ui/glyph.js";
import { Input } from "../components/ui/input.js";

type Panel = { readonly start: ConnectStart; readonly key: string } | { readonly landing: true } | null;

/** Where each cluster's tiles sit: size says how much the choice matters. */
const SIZES: Readonly<Record<ProviderGroup, "large" | "medium" | "small">> = {
  subscription: "large",
  gateway: "medium",
  local: "medium",
  key: "small",
  custom: "medium",
};

/**
 * First run: nothing is connected, so there is nothing to manage and the page
 * is the one task. Providers sit in clusters, each tile sized by how likely it
 * is the answer: the plans you already pay for are large, the long tail of
 * API-key providers is small and searchable. Choosing a tile runs its connect
 * flow in a panel in place of the grid; Esc or Cancel returns to the grid.
 * Servers found on this machine appear as the daemon finds them, while this
 * page is open.
 */
export const Splash = observer(function SplashView() {
  const dial = useDial();
  const rows = providerRows(dial.kernel?.root.drivers, dial.kernel?.root.connections);
  // A line that is down or redialing takes no writes, as the composer does not.
  const request = dial.link == null ? connectPort(dial) : null;
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState("");
  const grid = useRef<HTMLDivElement>(null);
  const opener = useRef("");

  // The daemon probes local ports only while someone looks at the drivers that offer them.
  const drivers = [...new Set(rows.map((row) => row.driver))];
  const driversKey = drivers.join("\0");
  useEffect(() => {
    dial.look([], drivers);
    return () => dial.look([], []);
    // The key stands for the list: a new array each render is not a new look.
  }, [dial, driversKey]);

  // Back from a flow, focus lands on the tile that started it.
  useEffect(() => {
    if (panel != null || opener.current === "") return;
    const tile = [...(grid.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? [])].find(
      (node) => node.dataset.tile === opener.current,
    );
    tile?.focus();
  }, [panel]);

  const start = (row: ProviderRow): void => {
    if (row.start == null) return;
    opener.current = row.key;
    setPanel({ start: row.start, key: row.key });
  };

  const needle = query.trim().toLowerCase();
  const by = (group: ProviderGroup) =>
    rows.filter(
      (row) =>
        row.group === group && (group !== "key" || `${row.name} ${row.description}`.toLowerCase().includes(needle)),
    );
  const tiles = (group: ProviderGroup) =>
    by(group).map((row) => <Tile key={row.key} row={row} enabled={request != null} onPick={() => start(row)} />);

  const subscriptions = tiles("subscription");
  const gateways = tiles("gateway");
  const local = tiles("local");
  const keyed = tiles("key");
  const custom = tiles("custom");

  return (
    <main className="splash" aria-label="Connect a model">
      <div className="splash-column">
        <header className="splash-head">
          <h1>Connect a model</h1>
          <p>Choose where completions come from. Add more any time.</p>
        </header>
        <LinkNotice />
        {panel == null ? (
          <div className="splash-clusters" ref={grid}>
            <div className="splash-col">
              {subscriptions.length === 0 ? null : <Cluster group="subscription" tiles={subscriptions} />}
              {gateways.length === 0 ? null : <Cluster group="gateway" tiles={gateways} />}
              <Cluster group="local" tiles={local} empty="Start Ollama or LM Studio and it shows up here." />
              {custom.length === 0 ? null : <Cluster group="custom" tiles={custom} />}
            </div>
            {by("key").length === 0 && needle === "" ? null : (
              <div className="splash-col">
                <Cluster
                  group="key"
                  tiles={keyed}
                  empty="No provider matches."
                  extra={
                    <Input
                      type="search"
                      className="splash-search"
                      aria-label="Search providers that take an API key"
                      placeholder="Search"
                      autoComplete="off"
                      spellCheck={false}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        const matches = by("key");
                        const only = matches.length === 1 ? matches.at(0) : undefined;
                        if (event.key === "Enter" && only != null) {
                          event.preventDefault();
                          start(only);
                        }
                      }}
                    />
                  }
                />
              </div>
            )}
          </div>
        ) : (
          <section className="splash-panel" aria-label="Connect">
            {"start" in panel && request != null ? (
              <ConnectStep
                key={panel.key}
                start={panel.start}
                request={request}
                // The kernel lists the connection and this page gives way; until then, say so.
                onDone={() => setPanel({ landing: true })}
                onCancel={() => setPanel(null)}
              />
            ) : (
              <p className="link-notice" role="status">
                <span className="link-glyph" data-settled="" aria-hidden />
                <span className="link-text">Connected. Opening your workspace…</span>
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
});

function Cluster({
  group,
  tiles,
  empty = "",
  extra,
}: {
  readonly group: ProviderGroup;
  readonly tiles: readonly ReactNode[];
  /** What a cluster with no tiles says, quietly. */
  readonly empty?: string;
  readonly extra?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="cluster" data-group={group} aria-labelledby={id}>
      <div className="cluster-head">
        <h2 className="label" id={id}>
          {GROUP_LABELS[group]}
        </h2>
        {extra}
      </div>
      {tiles.length === 0 ? (
        <p className="cluster-note">{empty}</p>
      ) : (
        <ul className="tiles" data-size={SIZES[group]}>
          {tiles}
        </ul>
      )}
    </section>
  );
}

/** One provider. The cluster sets the size; the offer's own facts fill it. */
function Tile({
  row,
  enabled,
  onPick,
}: {
  readonly row: ProviderRow;
  readonly enabled: boolean;
  readonly onPick: () => void;
}) {
  const size = SIZES[row.group];
  const note = tileNote(row);
  return (
    <li className="tile-item">
      <button
        type="button"
        className="tile"
        data-size={size}
        data-tile={row.key}
        disabled={!enabled || row.start == null}
        title={size === "small" ? (note ?? undefined) : undefined}
        onClick={onPick}
      >
        <span className="tile-top">
          {row.group === "local" ? <span className="visually-hidden">Running: </span> : null}
          <span className="tile-name">
            {row.group === "local" ? <span className="live-dot" aria-hidden /> : null}
            {row.name}
          </span>
        </span>
        {size === "small" || note == null ? null : (
          <span className={row.group === "local" ? "tile-copy mono" : "tile-copy"}>{note}</span>
        )}
        {size === "large" ? (
          <span className="tile-cue">
            Sign in through the browser
            <IconArrowRight {...glyph} aria-hidden />
          </span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * The line under a name, only where it adds to the cluster label: a plan says
 * whose plan, a local server says where it answers. The cluster already says
 * how each one signs in.
 */
function tileNote(row: ProviderRow): string | null {
  if (row.group === "subscription") return `Uses your ${row.name} plan`;
  if (row.group === "local") {
    const baseUrl = row.start?.settings?.baseUrl;
    try {
      const url = new URL(String(baseUrl));
      return `localhost:${url.port}`;
    } catch {
      return null;
    }
  }
  return restatesName(row) ? null : row.description;
}

/** "OpenRouter API" under OpenRouter says nothing the name does not. */
function restatesName(row: ProviderRow): boolean {
  const rest = row.description.toLowerCase().replace(row.name.toLowerCase(), "").trim();
  return rest === "" || rest === "api";
}
