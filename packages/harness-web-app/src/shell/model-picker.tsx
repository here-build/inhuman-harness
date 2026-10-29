import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { IconCheck, IconChevronRight, IconPlus } from "@tabler/icons-react";

import { ConnectStep, type Request } from "./connect-step.js";
import { modelChoiceValue, naturalName, type ModelChoice, type ModelWire } from "./model-choice.js";
import { GROUP_LABELS, type ConnectStart, type ProviderRow } from "./provider-list.js";
import { accountAnnotation, accountWindowLines } from "./wire-account.js";
import { glyph } from "../components/ui/glyph.js";

/** Hover opens a provider's models only after the pointer settles, so a diagonal path to an open submenu does not switch it. */
const HOVER_OPEN_MS = 120;

/** What the menu shows: the models, the providers to connect, a connect flow, or a connection waiting for its models. */
type View = "models" | "providers" | { readonly start: ConnectStart } | { readonly landing: string };

/**
 * The session's model. Each provider is a row whose models open in a nested
 * native popover; typing searches every provider at once. The popovers own the
 * top layer, light dismiss, and Esc (topmost first). Focus stays in the search
 * field; the arrow keys move the active row (combobox + listbox).
 *
 * Another provider is one row away ("Add a provider"), and a search reaches
 * it too. Connecting runs in the menu's own space, then opens the new
 * provider's models. (A first connection is the splash's, not the picker's.)
 */
export function ModelPicker({
  wires,
  providers,
  current,
  disabled,
  request,
  onChoose,
  onLook,
}: {
  readonly wires: readonly ModelWire[];
  /** What can still be connected. */
  readonly providers: readonly ProviderRow[];
  readonly current: ModelChoice;
  readonly disabled: boolean;
  /** The daemon port a connect flow talks to: the session's, else the kernel's. */
  readonly request: Request | null;
  readonly onChoose: (choice: ModelChoice) => void;
  /** What is in view: every wire while the menu is open, and the drivers whose offers are listed. None once it closes. */
  readonly onLook: (connections: readonly string[], drivers: readonly string[]) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const submenus = useRef(new Map<string, HTMLDivElement>());
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [subActive, setSubActive] = useState(0);
  const [view, setView] = useState<View>("models");
  const [visible, setVisible] = useState(false);
  // Quota countdowns are read at open; a menu is up for seconds, the windows for hours.
  const [now, setNow] = useState(() => Date.now());

  const needle = query.trim().toLowerCase();
  const searching = needle !== "";
  const connectable = request != null ? providers : [];
  const flow = typeof view === "object" && "start" in view ? view.start : null;
  const landing = typeof view === "object" && "landing" in view ? view.landing : null;
  const listing = flow == null && landing == null && view === "providers";
  const hits = searching
    ? connectable.filter((row) => `${row.name} ${row.description}`.toLowerCase().includes(needle))
    : connectable;
  const canAdd = !searching && connectable.length > 0;
  const currentValue = current.model.trim() === "" ? "" : modelChoiceValue(current);
  const currentWire = wires.find((wire) => wire.connection === current.connection);
  const results = searching
    ? wires
        .map((wire) => ({
          ...wire,
          choices: wire.choices.filter((choice) =>
            `${wire.name} ${choice.model} ${naturalName(choice.model)}`.toLowerCase().includes(needle),
          ),
        }))
        .filter((wire) => wire.choices.length > 0)
    : [];
  const resultRows = results.flatMap((wire) => wire.choices);
  const openWire = searching ? undefined : wires.find((wire) => wire.connection === open);
  const wireId = (index: number): string => `${id}-wire-${index}`;
  const optionId = (scope: string, index: number): string => `${id}-${scope}-${index}`;
  const anchor = (index: number): CSSProperties => ({ "--wire-anchor": `--model-wire-${index}` }) as CSSProperties;

  useEffect(() => {
    for (const row of root.current?.querySelectorAll("[data-active]") ?? []) row.scrollIntoView({ block: "nearest" });
  });

  const showModels = (wire: ModelWire): void => {
    clearTimeout(hover.current);
    const submenu = submenus.current.get(wire.connection);
    // Showing one provider's popover hides a sibling's: they nest under the same root.
    if (submenu != null && !submenu.matches(":popover-open")) submenu.showPopover();
  };

  const pick = (choice: ModelChoice | undefined): void => {
    if (choice == null) return;
    root.current?.hidePopover();
    onChoose(choice);
  };

  const wiresKey = wires.map((wire) => wire.connection).join("\0");
  const drivers = [...new Set(connectable.map((row) => row.driver))];
  const driversKey = drivers.join("\0");
  useEffect(() => {
    if (!visible) return;
    onLook(
      wires.map((wire) => wire.connection),
      listing ? drivers : [],
    );
    return () => onLook([], []);
    // The keys stand for the lists: a new array each render is not a new look.
  }, [visible, listing, wiresKey, driversKey]);

  // A new connection's models open beside its row as soon as the kernel lists them.
  useEffect(() => {
    if (landing == null) return;
    const wire = wires.find((candidate) => candidate.connection === landing);
    if (wire == null) return;
    setView("models");
    setActive(wires.indexOf(wire));
    requestAnimationFrame(() => showModels(wire));
  }, [landing, wiresKey]);

  // Back in the list, the search field has the keys again.
  useEffect(() => {
    if (flow == null) search.current?.focus();
  }, [flow]);

  const connect = (row: ProviderRow | undefined): void => {
    if (row?.start == null) return;
    setView({ start: row.start });
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape" && view === "providers") {
      // Esc backs out of the provider list before it closes the menu.
      event.preventDefault();
      event.stopPropagation();
      setView("models");
      setQuery("");
      return;
    }
    const length =
      openWire?.choices.length ??
      (listing ? hits.length : searching ? resultRows.length + hits.length : wires.length + (canAdd ? 1 : 0));
    const at = openWire == null ? active : subActive;
    const moves: Partial<Record<string, number>> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: length - 1 };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      (openWire == null ? setActive : setSubActive)(Math.max(0, Math.min(length - 1, move)));
      return;
    }
    if (openWire != null) {
      if (event.key === "Enter") pick(openWire.choices.at(subActive));
      if (event.key === "ArrowLeft") submenus.current.get(openWire.connection)?.hidePopover();
    } else if (listing) {
      if (event.key === "Enter") connect(hits.at(active));
      else if (event.key === "ArrowLeft" && !searching) setView("models");
      else return;
    } else if (searching) {
      if (event.key === "Enter") {
        if (active < resultRows.length) pick(resultRows.at(active));
        else connect(hits.at(active - resultRows.length));
      }
    } else if (event.key === "Enter" || event.key === "ArrowRight") {
      const wire = wires.at(active);
      if (wire != null) showModels(wire);
      else if (canAdd) setView("providers");
    } else {
      return;
    }
    if (event.key === "Enter" || event.key.startsWith("Arrow")) event.preventDefault();
  };

  const activeId =
    openWire != null
      ? optionId(openWire.connection, subActive)
      : listing
        ? hits.length === 0
          ? undefined
          : optionId("provider", active)
        : searching
          ? active < resultRows.length
            ? optionId("result", active)
            : hits.length === 0
              ? undefined
              : optionId("provider", active - resultRows.length)
          : active < wires.length
            ? wireId(active)
            : `${id}-add`;

  /** Provider rows by group, or one group of them when they sit under a search of models. */
  const providerRows = (offset: number, flat?: string) => {
    const groups = flat == null ? [...new Set(hits.map((row) => row.group))] : [null];
    return groups.map((group) => (
      <div
        className="model-group"
        key={group ?? "all"}
        role="group"
        aria-label={group == null ? flat : GROUP_LABELS[group]}
      >
        <div className="model-group-label label" aria-hidden>
          {group == null ? flat : GROUP_LABELS[group]}
        </div>
        {hits.map((row, at) =>
          group == null || row.group === group ? (
            <ProviderOption
              key={row.key}
              id={optionId("provider", at)}
              row={row}
              active={offset + at === active && open == null}
              onPoint={() => setActive(offset + at)}
              onPick={() => connect(row)}
            />
          ) : null,
        )}
      </div>
    ));
  };

  let resultIndex = -1;
  const named = current.model.trim() === "" ? "" : naturalName(current.model);
  return (
    <>
      <button
        type="button"
        className="model-trigger"
        popoverTarget={`${id}-root`}
        disabled={disabled}
        aria-label={`Model: ${named === "" ? "none chosen" : named}`}
      >
        <span className="truncate">{named === "" ? "Choose a model" : named}</span>
        {wires.length > 1 && current.connection !== "" ? (
          <span className="text-muted">{currentWire?.name ?? current.connection}</span>
        ) : null}
      </button>
      <div
        ref={root}
        id={`${id}-root`}
        popover="auto"
        className="model-menu model-picker"
        onToggle={(event) => {
          // React delivers the providers' toggles here too; only the root's own resets the menu.
          if (event.target !== event.currentTarget) return;
          clearTimeout(hover.current);
          setVisible(event.newState === "open");
          if (event.newState !== "open") return;
          setView("models");
          setQuery("");
          setNow(Date.now());
          setActive(currentWire == null ? 0 : Math.max(0, wires.indexOf(currentWire)));
          search.current?.focus();
        }}
      >
        <div className="model-sheet">
          {flow != null && request != null ? (
            <ConnectStep
              key={`${flow.driver}:${flow.name}`}
              start={flow}
              request={request}
              onDone={(connection) => {
                setQuery("");
                setView({ landing: connection });
              }}
              onCancel={() => setView("providers")}
            />
          ) : (
            <>
              <div
                className="model-list"
                id={`${id}-list`}
                role="listbox"
                aria-label={listing ? "Providers" : "Models"}
              >
                {landing != null ? (
                  <p className="model-empty" role="status">
                    Connected. Loading its models…
                  </p>
                ) : listing ? (
                  hits.length === 0 ? (
                    <p className="model-empty">No providers match</p>
                  ) : (
                    providerRows(0)
                  )
                ) : searching ? (
                  results.length === 0 && hits.length === 0 ? (
                    <p className="model-empty">No models match</p>
                  ) : (
                    <>
                      {results.map((wire) => (
                        <div className="model-group" key={wire.connection} role="group" aria-label={wire.name}>
                          {results.length > 1 ? (
                            <div className="model-group-label label" aria-hidden>
                              {wire.name}
                            </div>
                          ) : null}
                          {wire.choices.map((choice) => {
                            resultIndex += 1;
                            const at = resultIndex;
                            return (
                              <ModelOption
                                key={modelChoiceValue(choice)}
                                id={optionId("result", at)}
                                choice={choice}
                                selected={modelChoiceValue(choice) === currentValue}
                                active={at === active}
                                onPoint={() => setActive(at)}
                                onPick={() => pick(choice)}
                              />
                            );
                          })}
                        </div>
                      ))}
                      {hits.length === 0 ? null : providerRows(resultRows.length, "Add a provider")}
                    </>
                  )
                ) : (
                  [
                    ...wires.map((wire, index) => {
                      const funds = accountAnnotation(wire.account, now);
                      const lines = accountWindowLines(wire.account, now);
                      const accountTitle = [wire.account.detail, funds].filter((bit) => bit !== "").join("\n");
                      const showAccount =
                        wire.account.description !== "" || wire.account.balance !== "" || lines.length > 0;
                      return (
                        <div
                          className="model-option model-wire"
                          id={wireId(index)}
                          key={wire.connection}
                          role="option"
                          aria-selected={wire === currentWire}
                          aria-haspopup="listbox"
                          aria-expanded={open === wire.connection}
                          data-active={open == null && index === active ? "" : undefined}
                          data-open={open === wire.connection ? "" : undefined}
                          style={anchor(index)}
                          onPointerDown={(event) => event.preventDefault()}
                          onPointerEnter={() => {
                            setActive(index);
                            clearTimeout(hover.current);
                            hover.current = setTimeout(() => showModels(wire), HOVER_OPEN_MS);
                          }}
                          onPointerLeave={() => clearTimeout(hover.current)}
                          onClick={() => showModels(wire)}
                        >
                          <span className="truncate">{wire.name}</span>
                          <span className="model-wire-value truncate">{wire === currentWire ? named : ""}</span>
                          <IconChevronRight {...glyph} aria-hidden className="model-wire-chevron text-muted" />
                          {showAccount ? (
                            <span className="model-wire-account" title={accountTitle === "" ? undefined : accountTitle}>
                              {wire.account.description === "" ? null : (
                                <span data-failed={wire.account.failed ? "" : undefined}>
                                  {wire.account.description}
                                </span>
                              )}
                              {wire.account.balance === "" ? null : <span>{wire.account.balance}</span>}
                              {lines.map((line, at) => (
                                <span
                                  key={`${line.text}:${at}`}
                                  className="model-wire-funds"
                                  data-low={line.low ? "" : undefined}
                                >
                                  {line.text}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </div>
                      );
                    }),
                    canAdd ? (
                      <div
                        className="model-option"
                        id={`${id}-add`}
                        key="add"
                        role="option"
                        aria-selected={false}
                        data-active={open == null && active === wires.length ? "" : undefined}
                        onPointerDown={(event) => event.preventDefault()}
                        onPointerMove={() => setActive(wires.length)}
                        onClick={() => setView("providers")}
                      >
                        <span className="truncate">Add a provider</span>
                        <IconPlus {...glyph} aria-hidden className="shrink-0 text-muted" />
                      </div>
                    ) : null,
                  ]
                )}
              </div>
              <input
                ref={search}
                type="text"
                role="combobox"
                className="model-search"
                placeholder={listing ? "Search providers" : "Search models"}
                aria-label={listing ? "Search providers" : "Search models"}
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={activeId}
                value={query}
                onChange={(event) => {
                  if (open != null) submenus.current.get(open)?.hidePopover();
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
              />
            </>
          )}
        </div>
        {wires.map((wire, index) => (
          <div
            key={wire.connection}
            ref={(node) => {
              if (node == null) submenus.current.delete(wire.connection);
              else submenus.current.set(wire.connection, node);
            }}
            popover="auto"
            className="model-menu model-submenu"
            role="listbox"
            aria-label={wire.name}
            style={anchor(index)}
            onToggle={(event) => {
              if (event.newState === "open") {
                // ← returns to the provider these models came from.
                setActive(index);
                setOpen(wire.connection);
                setSubActive(
                  Math.max(
                    0,
                    wire.choices.findIndex((choice) => modelChoiceValue(choice) === currentValue),
                  ),
                );
              } else {
                setOpen((shown) => (shown === wire.connection ? null : shown));
              }
            }}
          >
            {open === wire.connection
              ? wire.choices.map((choice, at) => (
                  <ModelOption
                    key={modelChoiceValue(choice)}
                    id={optionId(wire.connection, at)}
                    choice={choice}
                    selected={modelChoiceValue(choice) === currentValue}
                    active={at === subActive}
                    onPoint={() => setSubActive(at)}
                    onPick={() => pick(choice)}
                  />
                ))
              : null}
          </div>
        ))}
      </div>
    </>
  );
}

function ModelOption({
  id,
  choice,
  selected,
  active,
  onPoint,
  onPick,
}: {
  readonly id: string;
  readonly choice: ModelChoice;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onPoint: () => void;
  readonly onPick: () => void;
}) {
  return (
    <div
      className="model-option"
      id={id}
      role="option"
      aria-selected={selected}
      data-active={active ? "" : undefined}
      // Keep focus in the search field; the click still lands.
      onPointerDown={(event) => event.preventDefault()}
      onPointerMove={onPoint}
      onClick={onPick}
    >
      <span className="truncate">{naturalName(choice.model)}</span>
      {selected ? <IconCheck {...glyph} aria-hidden className="shrink-0" /> : null}
    </div>
  );
}

function ProviderOption({
  id,
  row,
  active,
  onPoint,
  onPick,
}: {
  readonly id: string;
  readonly row: ProviderRow;
  readonly active: boolean;
  readonly onPoint: () => void;
  readonly onPick: () => void;
}) {
  return (
    <div
      className="model-option provider-option"
      id={id}
      role="option"
      aria-selected={false}
      aria-disabled={row.start == null ? true : undefined}
      data-active={active ? "" : undefined}
      onPointerDown={(event) => event.preventDefault()}
      onPointerMove={onPoint}
      onClick={onPick}
    >
      <span className="truncate">{row.name}</span>
      <span className="provider-hint">{row.hint}</span>
      {row.description === "" || row.description === row.name ? null : (
        <span className="provider-note truncate" title={row.description}>
          {row.description}
        </span>
      )}
    </div>
  );
}
