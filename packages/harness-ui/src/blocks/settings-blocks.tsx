import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { connectError, type ConnectRpcRequest } from "./connect-step-block.js";
import type { AccountSource } from "./providers.js";
import { Button, Input, Slider, SliderThumb, SliderTrack, Tooltip } from "../primitives/index.js";
import { useVoice } from "../voice/index.js";

/** Navigation item rendered inside `SettingsNav`. */
export interface SettingsNavItem {
  readonly id: string;
  readonly label: string;
}

/** Vertical section navigation list for settings dialogs. */
export function SettingsNav({
  items,
  activeId,
  ariaLabel,
  onSelect,
}: {
  readonly items: readonly SettingsNavItem[];
  readonly activeId: string;
  readonly ariaLabel?: string;
  readonly onSelect: (id: string) => void;
}) {
  const voice = useVoice();
  return (
    <nav className="settings-nav" aria-label={ariaLabel ?? voice.settings.title}>
      {items.map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          className="justify-start"
          aria-current={activeId === item.id ? "true" : undefined}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </Button>
      ))}
    </nav>
  );
}

/** Header row for the active settings panel with title and dismiss action. */
export function SettingsSectionHeader({
  titleId,
  title,
  closeLabel,
  onClose,
}: {
  readonly titleId: string;
  readonly title: string | undefined;
  readonly closeLabel?: string;
  readonly onClose?: () => void;
}) {
  const voice = useVoice();
  const label = closeLabel ?? voice.common.close;
  return (
    <header className="settings-head">
      <h2 id={titleId} className="text-xl leading-[26px]">
        {title}
      </h2>
      {onClose == null ? (
        <form method="dialog">
          <Button variant="ghost" type="submit">
            {label}
          </Button>
        </form>
      ) : (
        <Button variant="ghost" type="button" onClick={onClose}>
          {label}
        </Button>
      )}
    </header>
  );
}

/** Key/value pair displayed inside `SettingsFactList`. */
export interface SettingsFactItem {
  readonly key?: string;
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}

/** Expandable key/value definition list for technical connection details. */
export function SettingsFactList({
  facts,
  summaryLabel = "Details",
}: {
  readonly facts: readonly SettingsFactItem[];
  readonly summaryLabel?: string;
}) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted">{summaryLabel}</summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {facts.map((fact) => (
          <Fragment key={fact.key ?? fact.label}>
            <dt className="text-muted">{fact.label}</dt>
            <dd className={fact.mono === true ? "mono break-all" : "break-words"}>{fact.value}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

/** Signed-out door: says what happened and offers the next step in place. */
export function ReconnectDoorBlock({
  name,
  account,
  disabled,
  onReconnect,
}: {
  readonly name: string;
  readonly account: { readonly needsAuth: boolean; readonly description: string; readonly detail: string };
  readonly disabled: boolean;
  readonly onReconnect: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const why = account.needsAuth
    ? `${name} signed out or its key stopped working. Sign in again to keep using it; settings stay as they are.`
    : `${name} can’t be reached${account.description === "" ? "" : ` (${account.description})`}. Try reconnecting; if it keeps failing, check the details or remove it.`;
  return (
    <div
      className="flex flex-col gap-2 rounded-sm border border-danger p-3 text-sm"
      role="group"
      aria-label={`${name} needs attention`}
    >
      <p>{why}</p>
      <div className="settings-actions">
        <Button
          variant="default"
          disabled={disabled || busy}
          onClick={() => {
            setBusy(true);
            void onReconnect().then(() => setBusy(false));
          }}
        >
          {busy ? "Starting…" : account.needsAuth ? `Sign in to ${name}` : `Reconnect ${name}`}
        </Button>
      </div>
    </div>
  );
}

/** Small "?" that opens a popup explainer on hover and on keyboard focus. */
export function Hint({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Tooltip content={children} delay={150}>
      <button
        type="button"
        aria-label={`About ${label}`}
        className="inline-grid h-4 w-4 shrink-0 cursor-help place-items-center border border-line text-[10px] leading-none text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
      >
        ?
      </button>
    </Tooltip>
  );
}

/**
 * A control with its explainer pinned to the label row. The hint sits beside the
 * control, not inside its label, so the label stays the control's accessible name.
 */
export function Setting({
  label,
  hint,
  inline = false,
  children,
}: {
  readonly label: string;
  readonly hint: ReactNode;
  readonly inline?: boolean;
  readonly children: ReactNode;
}) {
  if (inline) {
    return (
      <div className="flex items-center gap-2">
        {children}
        <Hint label={label}>{hint}</Hint>
      </div>
    );
  }
  return (
    <div className="relative">
      {children}
      <span className="absolute right-0 top-0">
        <Hint label={label}>{hint}</Hint>
      </span>
    </div>
  );
}

/** Section container with title, subtitle, and grouped settings controls. */
export function SettingsGroupBlock({
  title,
  intro,
  children,
}: {
  readonly title: string;
  readonly intro: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-strong">{title}</h3>
        <p className="text-xs text-muted">{intro}</p>
      </div>
      {children}
    </section>
  );
}

/** Compatibility alias for `SettingsGroupBlock`. */
export const SettingsGroup = SettingsGroupBlock;

const PERCENT = { style: "unit", unit: "percent" } as const;

function SliderHeader({
  id,
  label,
  hint,
  readout,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: ReactNode;
  readonly readout: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span id={id}>{label}</span>
      <Hint label={label}>{hint}</Hint>
      <span className="ms-auto tabular-nums text-muted">{readout}</span>
    </div>
  );
}

/**
 * One track, two handles: soft and hard compaction triggers as shares of the
 * context window. Hard can never sit below soft. The track paints the three
 * zones the pair defines.
 */
export function TriggerRangeBlock({
  soft,
  hard,
  hint,
  note,
  onChange,
}: {
  readonly soft: number;
  readonly hard: number;
  readonly hint: ReactNode;
  readonly note?: string;
  readonly onChange: (soft: number, hard: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <SliderHeader id={id} label="Compaction thresholds" hint={hint} readout={`Soft ${soft}% · Hard ${hard}%`} />
      <Slider
        aria-labelledby={id}
        minValue={10}
        maxValue={100}
        step={1}
        value={[soft, hard]}
        formatOptions={PERCENT}
        onChange={(next) => {
          if (Array.isArray(next) && next.length === 2) onChange(next[0], next[1]);
        }}
      >
        <SliderTrack>
          {({ state }) => {
            const from = state.getThumbPercent(0) * 100;
            const to = state.getThumbPercent(1) * 100;
            return (
              <>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 bg-ink"
                  style={{ left: `${from}%`, width: `${to - from}%` }}
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 bg-danger"
                  style={{ left: `${to}%`, right: 0 }}
                />
                <SliderThumb index={0} aria-label="Soft trigger" />
                <SliderThumb index={1} aria-label="Hard trigger" />
              </>
            );
          }}
        </SliderTrack>
      </Slider>
      <p className="text-xs text-muted">
        {`Up to ${soft}% the context rail stays calm · ${soft}–${hard}% it warns · from ${hard}% the harness compacts on its own.`}
      </p>
      {note == null ? null : <p className="text-xs text-danger">{note}</p>}
    </div>
  );
}

/** Compatibility alias for `TriggerRangeBlock`. */
export const TriggerRange = TriggerRangeBlock;

/** A single share-of-something slider with its readout and explainer. */
export function PercentSliderBlock({
  label,
  hint,
  caption,
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  readonly label: string;
  readonly hint: ReactNode;
  readonly caption: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <SliderHeader id={id} label={label} hint={hint} readout={`${value}%`} />
      <Slider
        aria-labelledby={id}
        minValue={min}
        maxValue={max}
        step={1}
        value={value}
        formatOptions={PERCENT}
        onChange={(next) => {
          if (typeof next === "number") onChange(next);
        }}
      >
        <SliderTrack>
          {({ state }) => (
            <>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 bg-ink"
                style={{ left: 0, width: `${state.getThumbPercent(0) * 100}%` }}
              />
              <SliderThumb index={0} />
            </>
          )}
        </SliderTrack>
      </Slider>
      <p className="text-xs text-muted">{caption}</p>
    </div>
  );
}

/** Compatibility alias for `PercentSliderBlock`. */
export const PercentSlider = PercentSliderBlock;

/** Search result item returned from `mcp-server/search`. */
export interface RegistryHit {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly install: string;
}

/** Connected MCP connection shape inspected for login and install matching. */
export type McpFace = AccountSource & {
  readonly name?: string;
  readonly configuration?: { readonly [key: string]: unknown };
  readonly driver?: { readonly name?: string; readonly abilityClaim?: readonly string[] } | null;
};

/** Summary of an existing MCP copy matching a registry install string. */
export interface McpCopy {
  readonly id: string;
  readonly name: string;
  readonly login: string;
}

/** Rows from `mcp-server/search`. A row without a name or title is skipped. */
export function registryHits(result: unknown): RegistryHit[] {
  const servers = readField(result, "servers");
  if (!Array.isArray(servers)) return [];
  const hits: RegistryHit[] = [];
  for (const row of servers) {
    const name = readText(readField(row, "name"));
    const title = readText(readField(row, "title"));
    if (name === "" || title === "") continue;
    hits.push({
      name,
      title,
      description: readText(readField(row, "description")),
      install: readText(readField(row, "install")),
    });
  }
  return hits;
}

/** The install string a connection was adopted with: its URL, or its command line. */
export function connectionInstall(configuration: { readonly [key: string]: unknown } | undefined): string {
  if (configuration === undefined) return "";
  const url = readText(configuration.url);
  if (url !== "") return collapseWhitespace(url);
  const command = readText(configuration.command);
  if (command === "") return "";
  return collapseWhitespace([command, ...readStringList(configuration.args)].join(" "));
}

/**
 * What to say about this server's login.
 * A dead socket wins over a login prompt. HTTP with no reported person is
 * signed in once the driver is ready, and signed out while it is idle.
 * A stdio process has no login: it is Ready or Idle.
 */
export function mcpLoginLine(spec: McpFace, provider = ""): string {
  const name = provider.trim() === "" ? (spec.driver?.name ?? "") : provider.trim();
  const error = typeof spec.error === "string" ? spec.error : "";
  const failure = spec.readyState === "failed" && error !== "" ? connectError(name, error) : null;
  const needsAuth = readText(readField(spec.live, "auth")) === "needs-auth";
  if (failure?.kind === "connection") return failure.summary;
  if (failure?.kind === "auth" || needsAuth) return "Log in";
  if (spec.readyState === "failed") return "Failed";
  if (spec.readyState === "bootstrapping" || spec.readyState === "connecting") return "Connecting";
  if (!isHttpMcp(spec)) return spec.readyState === "ready" ? "Ready" : "Idle";
  const who = readPerson(spec);
  if (who !== "" && spec.readyState === "ready") return `Signed in as ${who}`;
  if (spec.readyState === "ready") return "Signed in";
  return "Signed out";
}

/** Connected MCP copies whose install string is this one. Each keeps its own login. */
export function mcpCopies(rows: readonly (readonly [string, McpFace])[], install: string): McpCopy[] {
  const wanted = collapseWhitespace(install);
  if (wanted === "") return [];
  const copies: McpCopy[] = [];
  for (const [id, spec] of rows) {
    if (id.startsWith("__") || !isMcpConnection(spec)) continue;
    if (collapseWhitespace(connectionInstall(spec.configuration)) !== wanted) continue;
    const name = shownText(spec.name, id);
    copies.push({ id, name, login: mcpLoginLine(spec, name) });
  }
  return copies;
}

/** Empty while the field is empty or results are showing. */
export function registryStatus(query: string, pending: boolean, hits: number): string {
  if (query.trim() === "") return "";
  if (pending) return "Searching…";
  if (hits === 0) return "No servers match.";
  return "";
}

/** Visible button label for adopting an MCP registry entry. */
export function registryAddWord(install: string, copies: number): string {
  if (install.trim() === "") return "No install";
  if (copies === 0) return "Add";
  return "Add another";
}

/** Accessible button label for adopting an MCP registry entry. */
export function registryAddLabel(title: string, install: string, copies: number): string {
  if (install.trim() === "") return `No install published for ${title}`;
  if (copies === 0) return `Add ${title}`;
  return `Add another ${title}`;
}

const SEARCH_WAIT_MS = 300;

/**
 * Official-registry search. Add adopts the install string again, so a server
 * that is already connected can be added as another copy with its own login.
 */
export function RegistrySearchBlock({
  request,
  rows,
  disabled,
  onNotice,
  onAdopt,
  noticeId,
}: {
  readonly request: ConnectRpcRequest | null;
  readonly rows: readonly (readonly [string, McpFace])[];
  readonly disabled: boolean;
  readonly onNotice: (message: string) => void;
  readonly onAdopt: (hit: RegistryHit) => void;
  readonly noticeId?: string;
}) {
  const helpId = useId();
  const statusId = useId();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RegistryHit[]>([]);
  const [pending, setPending] = useState(false);
  const requestRef = useRef(request);
  const noticeRef = useRef(onNotice);
  requestRef.current = request;
  noticeRef.current = onNotice;
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setHits([]);
      setPending(false);
      return;
    }
    let live = true;
    setHits([]);
    setPending(true);
    const timer = setTimeout(() => {
      const current = requestRef.current;
      if (!live) return;
      if (current == null) {
        setPending(false);
        noticeRef.current("The daemon is not connected.");
        return;
      }
      void current("mcp-server/search", { query: q }).then(
        (result) => {
          if (!live) return undefined;
          setPending(false);
          setHits(registryHits(result));
          noticeRef.current("");
          return undefined;
        },
        (error: unknown) => {
          if (!live) return undefined;
          setPending(false);
          setHits([]);
          noticeRef.current(error instanceof Error ? error.message : "The registry didn’t answer.");
          return undefined;
        },
      );
    }, SEARCH_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const status = registryStatus(query, pending, hits.length);
  return (
    <div className="text-sm">
      <label className="block">
        Search servers
        <Input
          className="mt-1"
          aria-describedby={[helpId, status === "" ? null : statusId, noticeId].filter(Boolean).join(" ")}
          value={query}
          placeholder="Name"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p id={helpId} className="mt-1 text-sm text-muted">
        Searches server names in the official registry. Each server you add signs in on its own.
      </p>
      {status === "" ? null : (
        <p id={statusId} className="mt-2 text-sm text-muted" role="status">
          {status}
        </p>
      )}
      {hits.length === 0 ? null : (
        <div className="settings-list mt-2">
          {hits.map((hit) => {
            const copies = mcpCopies(rows, hit.install);
            return (
              <div key={hit.name} className="settings-row">
                <p className="text-sm font-strong">{hit.title}</p>
                {hit.description === "" ? null : <p className="settings-clamp text-sm text-muted">{hit.description}</p>}
                {copies.length === 0 ? (
                  <p className="text-sm text-muted">Not connected</p>
                ) : (
                  copies.map((copy) => (
                    <p key={copy.id} className="text-sm text-muted">
                      {copy.name} · {copy.login}
                    </p>
                  ))
                )}
                <Button
                  className="self-start"
                  variant="secondary"
                  aria-label={registryAddLabel(hit.title, hit.install, copies.length)}
                  disabled={disabled || hit.install.trim() === ""}
                  onClick={() => onAdopt(hit)}
                >
                  {registryAddWord(hit.install, copies.length)}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function isHttpMcp(spec: McpFace): boolean {
  if (spec.driver?.name === "mcp-http") return true;
  if (spec.driver?.name === "mcp-stdio") return false;
  return readText(spec.configuration?.url).startsWith("http");
}

function isMcpConnection(spec: McpFace): boolean {
  if (spec.driver?.abilityClaim?.includes("mcp") === true) return true;
  const name = spec.driver?.name ?? "";
  return name === "mcp-http" || name === "mcp-stdio";
}

function readPerson(spec: McpFace): string {
  const identity = readField(spec.live, "identity");
  const name = readText(readField(identity, "displayName"));
  if (name !== "") return name;
  return readText(readField(identity, "email"));
}

function shownText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    const line = readText(item);
    if (line !== "") items.push(line);
  }
  return items;
}

function collapseWhitespace(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!Object.hasOwn(value, key)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
