import type { ReactNode } from "react";
import { IconPlus } from "@tabler/icons-react";

import { Button } from "../primitives/button.js";
import { FieldInput, Label, SearchField } from "../primitives/form-controls.js";
import { glyph } from "../primitives/glyph.js";
import { Link } from "../primitives/navigation.js";
import { useVoice } from "../voice/index.js";

/** Liveness indicator rendered beside a session row in the rail. */
export type RowLight = "running" | "waiting-for-you" | "idle";

/** Pure presentation model for one session row in the sidebar rail. */
export interface SessionRailItem {
  readonly key: string;
  readonly href: string;
  readonly label: string;
  readonly light: RowLight;
  readonly selected: boolean;
  readonly title?: string;
  readonly age?: string;
  readonly detail?: string;
}

/** Grouped bot sessions shown under the Bots rail pane. */
export interface SessionRailBotGroup {
  readonly key: string;
  readonly name: string;
  readonly rows: readonly SessionRailItem[];
}

export interface SessionRailBlockProps {
  readonly navLabel?: string;
  readonly busy?: boolean;
  readonly busyMessage?: string | null;
  readonly heading?: string;
  readonly headingTitle?: string;
  readonly mode: "overview" | "project" | "bots" | "connecting";
  readonly onMint?: () => void;
  readonly mintLabel?: string;
  readonly mintDisabled?: boolean;
  readonly notice?: ReactNode;
  readonly attachingMessage?: string | null;
  readonly showSearch?: boolean;
  readonly searchQuery?: string;
  readonly onSearchChange?: (value: string) => void;
  readonly searchLabel?: string;
  readonly emptyMessage?: string;
  readonly items?: readonly SessionRailItem[];
  readonly botGroups?: readonly SessionRailBotGroup[];
  readonly onNavigate: (href: string) => void;
}

const rowClass =
  "touch-target flex min-h-8 w-full items-center gap-2 rounded-none border-l-2 border-transparent px-6 py-1 text-left text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus aria-[current=page]:border-selection-marker aria-[current=page]:bg-selected aria-[current=page]:font-strong";

/**
 * Pure session-list rail block supporting overview, project, bots, and initial connecting views.
 */
export function SessionRailBlock({
  navLabel,
  busy = false,
  busyMessage = null,
  heading = "",
  headingTitle,
  mode,
  onMint,
  mintLabel,
  mintDisabled = false,
  notice,
  attachingMessage = null,
  showSearch = false,
  searchQuery = "",
  onSearchChange,
  searchLabel = "Filter sessions",
  emptyMessage = "",
  items = [],
  botGroups = [],
  onNavigate,
}: SessionRailBlockProps) {
  const voice = useVoice();
  const ariaLabel = navLabel ?? voice.workspace.sessionsLabel;

  if (mode === "connecting" || busy) {
    return (
      <nav className="px-4 py-4" aria-label={ariaLabel} aria-busy="true">
        {busyMessage == null || busyMessage === "" ? null : (
          <p className="text-sm text-muted" role="status">
            {busyMessage}
          </p>
        )}
      </nav>
    );
  }

  if (mode === "bots") {
    return (
      <nav className="flex min-h-0 flex-1 flex-col" aria-label={ariaLabel}>
        <header className="flex min-h-12 shrink-0 items-center px-4 py-3">
          <h2 className="text-base">{heading}</h2>
        </header>
        {botGroups.length === 0 ? (
          <p className="px-4 py-2 text-sm text-subtle">{emptyMessage}</p>
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto pb-3">
            {botGroups.map((group) => (
              <li key={group.key}>
                <p className="truncate px-6 py-1 text-sm font-strong text-muted" title={group.key || undefined}>
                  {group.name}
                </p>
                <ul>
                  {group.rows.map((row) => (
                    <RailRow key={row.key} row={row} onNavigate={onNavigate} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </nav>
    );
  }

  if (mode === "overview") {
    return (
      <nav className="flex min-h-0 flex-1 flex-col" aria-label={ariaLabel}>
        {heading === "" && items.length === 0 && !showSearch ? (
          <p className="px-4 py-4 text-sm text-subtle" role="status">
            {emptyMessage}
          </p>
        ) : (
          <>
            <header className="flex min-h-12 shrink-0 items-center px-4 py-3">
              <h2 className="text-base">{heading}</h2>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 pb-3">
              {showSearch && onSearchChange != null ? (
                <SearchField className="mx-3" value={searchQuery} onChange={onSearchChange}>
                  <Label>{searchLabel}</Label>
                  <FieldInput />
                </SearchField>
              ) : null}
              {items.length === 0 ? (
                <p className="px-6 py-1 text-sm text-subtle">{emptyMessage}</p>
              ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {items.map((row) => (
                    <RailRow key={row.key} row={row} onNavigate={onNavigate} />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </nav>
    );
  }

  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label={ariaLabel}>
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 px-4 py-3">
        <h2 className="min-w-0 truncate text-base" title={headingTitle}>
          {heading}
        </h2>
        {onMint == null ? null : (
          <Button
            variant="ghost"
            className="size-8 shrink-0 p-0 text-muted hover:text-ink"
            aria-label={mintLabel ?? voice.workspace.newSessionLabel}
            disabled={mintDisabled}
            onClick={onMint}
          >
            <IconPlus {...glyph} aria-hidden />
          </Button>
        )}
      </header>
      {notice}
      {attachingMessage != null ? (
        <p className="px-4 py-2 text-sm text-subtle" role="status">
          {attachingMessage}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 pb-3">
          {showSearch && onSearchChange != null ? (
            <SearchField className="mx-3" value={searchQuery} onChange={onSearchChange}>
              <Label>{searchLabel}</Label>
              <FieldInput />
            </SearchField>
          ) : null}
          {items.length === 0 ? (
            <p className="px-6 py-1 text-sm text-subtle">{emptyMessage}</p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {items.map((row) => (
                <RailRow key={row.key} row={row} onNavigate={onNavigate} />
              ))}
            </ul>
          )}
        </div>
      )}
    </nav>
  );
}

function RailRow({ row, onNavigate }: { readonly row: SessionRailItem; readonly onNavigate: (href: string) => void }) {
  const title = row.title ?? row.label;
  const detail = row.detail ?? "";
  const age = row.age ?? "";

  return (
    <li>
      <Link
        className={`${rowClass} no-underline`}
        href={row.href}
        aria-current={row.selected ? "page" : undefined}
        title={detail === "" ? title : `${title} — ${detail}`}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onNavigate(row.href);
        }}
      >
        <Light light={row.light} />
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {detail === "" ? null : <span className="max-w-32 shrink-0 truncate text-muted">{detail}</span>}
        {age === "" ? null : <time className="shrink-0 text-xs tabular-nums text-subtle">{age}</time>}
      </Link>
    </li>
  );
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
