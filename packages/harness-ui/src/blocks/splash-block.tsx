import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconArrowRight } from "@tabler/icons-react";

import {
  ConnectStepBlock,
  type ConnectParkForm,
  type ConnectRpcRequest,
  type ConnectStepStart,
} from "./connect-step-block.js";
import { GROUP_LABELS, type ProviderGroup, type ProviderRow } from "./providers.js";
import { Button } from "../primitives/button.js";
import { FieldInput, Label, SearchField } from "../primitives/form-controls.js";
import { glyph } from "../primitives/glyph.js";

type Panel = { readonly start: ConnectStepStart; readonly key: string } | { readonly landing: true } | null;

/** Where each cluster's tiles sit: size says how much the choice matters. */
const SIZES: Readonly<Record<ProviderGroup, "large" | "medium" | "small">> = {
  subscription: "large",
  gateway: "medium",
  local: "medium",
  key: "small",
  custom: "medium",
};

export interface SplashBlockProps {
  readonly rows: readonly ProviderRow[];
  readonly request: ConnectRpcRequest | null;
  readonly parsePark?: (body: string) => Promise<ConnectParkForm>;
  readonly notice?: ReactNode;
  readonly heading?: string;
  readonly subtitle?: string;
  readonly connectedMessage?: string;
  readonly onDriversFocus?: (drivers: readonly string[]) => void;
}

/**
 * First-run provider onboarding wall with clustered tiles and an inline connection step panel.
 */
export function SplashBlock({
  rows,
  request,
  parsePark,
  notice,
  heading = "Connect a model",
  subtitle = "Choose where completions come from. Add more any time.",
  connectedMessage = "Connected. Opening your workspace…",
  onDriversFocus,
}: SplashBlockProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState("");
  const grid = useRef<HTMLDivElement>(null);
  const opener = useRef("");
  const onDriversFocusRef = useRef(onDriversFocus);
  onDriversFocusRef.current = onDriversFocus;

  const drivers = [...new Set(rows.map((row) => row.driver))];
  const driversKey = drivers.join("\0");
  useEffect(() => {
    const callback = onDriversFocusRef.current;
    if (callback == null) return;
    const list = driversKey === "" ? [] : driversKey.split("\0");
    callback(list);
    return () => callback([]);
  }, [driversKey]);

  // Back from a flow, focus lands on the tile that started it.
  useEffect(() => {
    if (panel != null || opener.current === "") return;
    const tile = [...(grid.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? [])].find(
      (node) => node.dataset.tile === opener.current,
    );
    tile?.focus();
  }, [panel]);

  const start = (row: ProviderRow): void => {
    if (request == null || row.start == null) return;
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
    <main className="splash" aria-label={heading}>
      <div className="splash-column">
        <header className="splash-head">
          <h1>{heading}</h1>
          <p>{subtitle}</p>
        </header>
        {notice}
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
                    <SearchField
                      className="splash-search"
                      value={query}
                      onChange={setQuery}
                      onSubmit={() => {
                        const matches = by("key");
                        const only = matches.length === 1 ? matches.at(0) : undefined;
                        if (only != null) start(only);
                      }}
                    >
                      <Label>Search API-key providers</Label>
                      <FieldInput
                        aria-label="Search providers that take an API key"
                        placeholder="Search"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </SearchField>
                  }
                />
              </div>
            )}
          </div>
        ) : (
          <section className="splash-panel" aria-label="Connect">
            {"start" in panel && request != null ? (
              <ConnectStepBlock
                key={panel.key}
                start={panel.start}
                request={request}
                parsePark={parsePark}
                onDone={() => setPanel({ landing: true })}
                onCancel={() => setPanel(null)}
              />
            ) : (
              <p className="link-notice" role="status">
                <span className="link-glyph" data-settled="" aria-hidden />
                <span className="link-text">{connectedMessage}</span>
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

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
        <h2 id={id}>{GROUP_LABELS[group]}</h2>
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
      <Button
        variant="secondary"
        className="tile"
        style={{ fontVariantCaps: "normal", letterSpacing: "normal" }}
        data-size={size}
        data-tile={row.key}
        disabled={!enabled || row.start == null}
        title={size === "small" ? (note ?? undefined) : undefined}
        onClick={onPick}
      >
        <span className="tile-top">
          {row.group === "local" ? <span className="visually-hidden">Running: </span> : null}
          <span className="tile-name" style={{ fontFamily: "var(--font-sans)" }}>
            {row.group === "local" ? <span className="live-dot" aria-hidden /> : null}
            {row.name}
          </span>
        </span>
        {size === "small" || note == null ? null : (
          <span className={row.group === "local" ? "tile-copy mono" : "tile-copy"}>{note}</span>
        )}
        {size === "large" ? (
          <span className="tile-cue label">
            Sign in through the browser
            <IconArrowRight {...glyph} aria-hidden />
          </span>
        ) : null}
      </Button>
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
