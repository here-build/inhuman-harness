import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { IconCheck, IconChevronRight } from "@tabler/icons-react";

import { ConnectStep, type Request } from "./connect-step.js";
import {
  formatModelPricing,
  modelBadges,
  modelChoiceValue,
  naturalName,
  openrouterProvider,
  type ModelChoice,
  type ModelWire,
  type OpenRouterProvider,
} from "./model-choice.js";
import { ProviderIcon } from "./provider-icons.js";
import type { ConnectStart, ProviderRow } from "./provider-list.js";
import { accountAnnotation, accountWindowLines } from "./wire-account.js";
import { Button } from "../components/ui/button.js";
import { glyph } from "../components/ui/glyph.js";
import { Input } from "../components/ui/input.js";

const SINGLE_PROVIDER_SEARCH_THRESHOLD = 20;

type PreparedChoice = {
  readonly choice: ModelChoice;
  readonly value: string;
  readonly label: string;
  readonly badges: readonly string[];
  readonly priceText: string;
  readonly provider?: OpenRouterProvider;
  readonly searchText: string;
};

type PreparedWire = {
  readonly wire: ModelWire;
  readonly items: readonly PreparedChoice[];
};

/** What the menu shows: the models, a reconnect flow, or a connection waiting for its models. */
type View = "models" | { readonly start: ConnectStart } | { readonly landing: string };

/**
 * The session's model. When one ready provider is connected, its models open
 * directly in the main popover (with a search input when there are more than
 * 20 models). With multiple providers, each provider is a single-line row
 * whose models open in a nested native popover; typing searches every
 * provider at once.
 */
export function ModelPicker({
  wires,
  current,
  disabled,
  request,
  onChoose,
  onLook,
}: {
  readonly wires: readonly ModelWire[];
  readonly providers?: readonly ProviderRow[];
  readonly current: ModelChoice;
  readonly disabled: boolean;
  /** The daemon port a reconnect flow talks to: the session's, else the kernel's. */
  readonly request: Request | null;
  readonly onChoose: (choice: ModelChoice) => void;
  /** What is in view: every wire while the menu is open. None once it closes. */
  readonly onLook: (connections: readonly string[], drivers: readonly string[]) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const submenus = useRef(new Map<string, HTMLDivElement>());
  const shouldScroll = useRef(false);
  // Closing ends the current interaction, even when an RPC completes later.
  const interaction = useRef(0);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [subActive, setSubActive] = useState(0);
  const [view, setView] = useState<View>("models");
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  // Quota countdowns are read at open; a menu is up for seconds, the windows for hours.
  const [now, setNow] = useState(() => Date.now());

  const preparedWires = useMemo<readonly PreparedWire[]>(
    () =>
      wires.map((wire) => ({
        wire,
        items: wire.choices.map((choice) => prepareChoice(wire, choice)),
      })),
    [wires],
  );
  const preparedByConnection = useMemo(
    () => new Map(preparedWires.map((entry) => [entry.wire.connection, entry.items])),
    [preparedWires],
  );

  const singleWire = wires.length === 1 && !wires[0]!.account.needsAuth ? wires[0]! : undefined;
  const showSearch = singleWire == null || singleWire.choices.length > SINGLE_PROVIDER_SEARCH_THRESHOLD;
  const needle = showSearch ? query.trim().toLowerCase() : "";
  const searching = needle !== "";
  const flow = typeof view === "object" && "start" in view ? view.start : null;
  const landing = typeof view === "object" && "landing" in view ? view.landing : null;
  const currentValue = current.model.trim() === "" ? "" : modelChoiceValue(current);
  const currentWire = wires.find((wire) => wire.connection === current.connection);
  const results = useMemo(
    () =>
      searching
        ? preparedWires
            .map(({ wire, items }) => ({
              wire,
              items: items.filter((item) => item.searchText.includes(needle)),
            }))
            .filter((entry) => entry.items.length > 0)
        : [],
    [searching, preparedWires, needle],
  );
  const resultItems = useMemo(() => results.flatMap((entry) => entry.items), [results]);
  const authResults =
    searching && singleWire == null
      ? wires.filter((wire) => wire.account.needsAuth && wire.name.toLowerCase().includes(needle))
      : [];
  const singleItems =
    singleWire == null
      ? []
      : searching
        ? (results[0]?.items ?? [])
        : (preparedByConnection.get(singleWire.connection) ?? []);
  const openWire = searching || singleWire != null ? undefined : wires.find((wire) => wire.connection === open);
  const wireId = (index: number): string => `${id}-wire-${index}`;
  const optionId = (scope: string, index: number): string => `${id}-${scope}-${index}`;
  const anchor = (index: number): CSSProperties => ({ "--wire-anchor": `--model-wire-${index}` }) as CSSProperties;

  useEffect(() => {
    if (!shouldScroll.current) return;
    shouldScroll.current = false;
    for (const row of root.current?.querySelectorAll("[data-active]") ?? []) row.scrollIntoView({ block: "nearest" });
  }, [active, subActive, open]);

  const showModels = (wire: ModelWire): void => {
    const wireIndex = wires.indexOf(wire);
    if (wireIndex !== -1) setActive(wireIndex);
    if (wire.account.needsAuth) setQuery("");
    if (open !== wire.connection) {
      shouldScroll.current = true;
      setOpen(wire.connection);
      setSubActive(
        wire.account.needsAuth
          ? 0
          : Math.max(
              0,
              wire.choices.findIndex((choice) => modelChoiceValue(choice) === currentValue),
            ),
      );
    }
    const submenu = submenus.current.get(wire.connection);
    // Showing one provider's popover hides a sibling's: they nest under the same root.
    if (submenu != null && !submenu.matches(":popover-open")) submenu.showPopover();
  };

  const pick = useCallback(
    (choice: ModelChoice | undefined): void => {
      if (choice == null || wires.find((wire) => wire.connection === choice.connection)?.account.needsAuth) return;
      root.current?.hidePopover();
      onChoose(choice);
    },
    [onChoose, wires],
  );

  const wiresKey = wires
    .map((wire) => `${wire.connection}:${wire.account.needsAuth}:${wire.choices.length}`)
    .join("\0");
  useEffect(() => {
    if (!visible) return;
    onLook(
      wires.map((wire) => wire.connection),
      [],
    );
    return () => onLook([], []);
    // The keys stand for the lists: a new array each render is not a new look.
  }, [visible, wiresKey]);

  // A reconnected provider's models open beside its row as soon as the kernel lists them.
  useEffect(() => {
    if (landing == null) return;
    const wire = wires.find((candidate) => candidate.connection === landing);
    if (wire == null) return;
    setView("models");
    setActive(wires.indexOf(wire));
    if (wires.length > 1) requestAnimationFrame(() => showModels(wire));
  }, [landing, wiresKey]);

  useEffect(() => {
    if (openWire?.account.needsAuth) setSubActive(0);
    if (open != null && !wires.some((wire) => wire.connection === open)) setOpen(null);
  }, [open, openWire?.account.needsAuth, wiresKey]);

  useEffect(() => {
    if (flow == null) (search.current ?? list.current)?.focus();
  }, [flow, showSearch]);

  const reconnect = (wire: ModelWire): void => {
    if (request == null || removing != null) return;
    submenus.current.get(wire.connection)?.hidePopover();
    setOpen(null);
    setView({ start: { driver: "", name: wire.name, reconnect: wire.connection } });
  };

  const remove = async (wire: ModelWire): Promise<void> => {
    if (request == null || removing != null) return;
    const mine = interaction.current;
    setRemoving(wire.connection);
    setNotice("");
    try {
      const result = await request("connect/drop", { id: wire.connection, confirm: true });
      if (typeof result !== "object" || result == null || !("ok" in result) || result.ok !== true) {
        throw new Error("Could not delete the provider. Try again.");
      }
      if (mine !== interaction.current) return;
      submenus.current.get(wire.connection)?.hidePopover();
      setOpen(null);
      setActive(0);
    } catch (error) {
      if (mine !== interaction.current) return;
      setNotice(error instanceof Error ? error.message : "Could not delete the provider. Try again.");
    } finally {
      setRemoving(null);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLElement>): void => {
    const length =
      singleWire != null
        ? singleItems.length
        : ((openWire == null ? undefined : openWire.account.needsAuth ? 2 : openWire.choices.length) ??
          (searching ? resultItems.length + authResults.length : wires.length));
    const at = openWire == null ? active : subActive;
    const moves: Partial<Record<string, number>> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: length - 1 };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      if (length > 0) {
        shouldScroll.current = true;
        (openWire == null ? setActive : setSubActive)(Math.max(0, Math.min(length - 1, move)));
      }
      return;
    }
    if (singleWire != null) {
      if (event.key === "Enter") pick(singleItems.at(active)?.choice);
      else return;
    } else if (openWire != null) {
      if (event.key === "Enter") {
        if (openWire.account.needsAuth) {
          if (subActive === 0) reconnect(openWire);
          else void remove(openWire);
        } else pick(openWire.choices.at(subActive));
      }
      if (event.key === "ArrowLeft") submenus.current.get(openWire.connection)?.hidePopover();
    } else if (searching) {
      if (event.key === "Enter") {
        if (active < resultItems.length) pick(resultItems.at(active)?.choice);
        else {
          const wire = authResults.at(active - resultItems.length);
          if (wire != null) showModels(wire);
        }
      }
    } else if (event.key === "Enter" || event.key === "ArrowRight") {
      const wire = wires.at(active);
      if (wire != null) showModels(wire);
    } else {
      return;
    }
    if (event.key === "Enter" || event.key.startsWith("Arrow")) event.preventDefault();
  };

  const activeId =
    singleWire != null
      ? singleItems.length === 0
        ? undefined
        : optionId(searching ? "result" : singleWire.connection, active)
      : openWire != null
        ? optionId(openWire.connection, subActive)
        : searching
          ? active < resultItems.length
            ? optionId("result", active)
            : active < resultItems.length + authResults.length
              ? optionId("auth", active - resultItems.length)
              : undefined
          : active < wires.length
            ? wireId(active)
            : undefined;

  const renderChoices = (
    wire: ModelWire,
    items: readonly PreparedChoice[],
    scope: string,
    activeIndex: number,
    onPoint: (index: number) => void,
    startOffset = 0,
  ): ReactNode => {
    if (wire.openrouter && items.some((item) => item.provider !== undefined)) {
      const groups: { provider: OpenRouterProvider; entries: { item: PreparedChoice; index: number }[] }[] = [];
      for (const [idx, item] of items.entries()) {
        const provider = item.provider ?? openrouterProvider(item.choice.model);
        const last = groups.at(-1);
        const index = startOffset + idx;
        if (last?.provider.key === provider.key) {
          last.entries.push({ item, index });
        } else {
          groups.push({ provider, entries: [{ item, index }] });
        }
      }
      return groups.map(({ provider, entries }) => (
        <div className="model-group" key={provider.key} role="group" aria-label={provider.label}>
          <div className="model-group-label" aria-hidden>
            <span>{provider.label}</span>
            {provider.icon === undefined ? null : <ProviderIcon provider={provider.icon} />}
          </div>
          {entries.map(({ item, index }) => (
            <ModelOption
              key={item.value}
              id={optionId(scope, index)}
              item={item}
              index={index}
              selected={item.value === currentValue}
              active={index === activeIndex}
              onPoint={onPoint}
              onPick={pick}
            />
          ))}
        </div>
      ));
    }
    return items.map((item, idx) => {
      const index = startOffset + idx;
      return (
        <ModelOption
          key={item.value}
          id={optionId(scope, index)}
          item={item}
          index={index}
          selected={item.value === currentValue}
          active={index === activeIndex}
          onPoint={onPoint}
          onPick={pick}
        />
      );
    });
  };

  let resultOffset = 0;
  const currentApiName = currentWire?.modelNames?.[current.model];
  const currentPricing = currentWire?.modelPricing?.[current.model];
  const named = current.model.trim() === "" ? "" : naturalName(current.model, currentApiName);
  const currentBadges = current.model.trim() === "" ? [] : modelBadges(current.model, currentApiName, currentPricing);
  return (
    <>
      <Button
        variant="ghost"
        className="model-trigger"
        popoverTarget={`${id}-root`}
        disabled={disabled}
        aria-label={`Model: ${named === "" ? "none chosen" : named}`}
      >
        <span className={named === "" ? "truncate" : "truncate [font-variant-caps:normal] tracking-normal"}>
          {named === "" ? "Choose a model" : named}
        </span>
        {currentBadges.map((badge) => (
          <span key={badge} className="model-badge">
            {badge}
          </span>
        ))}
        {wires.length > 1 && current.connection !== "" ? (
          <span className="text-muted [font-variant-caps:normal] tracking-normal">
            {currentWire?.name ?? current.connection}
          </span>
        ) : null}
      </Button>
      <div
        ref={root}
        id={`${id}-root`}
        popover="auto"
        className="model-menu model-picker"
        onToggle={(event) => {
          // React delivers the providers' toggles here too; only the root's own resets the menu.
          if (event.target !== event.currentTarget) return;
          setVisible(event.newState === "open");
          if (event.newState !== "open") {
            interaction.current += 1;
            setOpen(null);
            // Unmounting ConnectStep releases its held park immediately.
            setView("models");
            return;
          }
          setView("models");
          setQuery("");
          setNotice("");
          setNow(Date.now());
          shouldScroll.current = true;
          if (singleWire != null) {
            setActive(
              Math.max(
                0,
                singleWire.choices.findIndex((choice) => modelChoiceValue(choice) === currentValue),
              ),
            );
          } else {
            setActive(currentWire == null ? 0 : Math.max(0, wires.indexOf(currentWire)));
          }
          (search.current ?? list.current)?.focus();
        }}
      >
        <div className="model-sheet">
          {flow != null && request != null ? (
            <ConnectStep
              key={`${flow.reconnect ?? flow.driver}:${flow.name}`}
              start={flow}
              request={request}
              onDone={(connection) => {
                setQuery("");
                setView({ landing: connection });
              }}
              onCancel={() => setView("models")}
            />
          ) : (
            <>
              <div
                ref={list}
                className="model-list"
                id={`${id}-list`}
                role="listbox"
                aria-label="Models"
                aria-activedescendant={showSearch ? undefined : activeId}
                tabIndex={showSearch ? undefined : -1}
                onKeyDown={showSearch ? undefined : onKey}
              >
                {landing != null ? (
                  <p className="model-empty" role="status">
                    Connected. Loading its models…
                  </p>
                ) : singleWire != null ? (
                  singleItems.length === 0 ? (
                    <p className="model-empty" role="status">
                      No models match
                    </p>
                  ) : (
                    renderChoices(
                      singleWire,
                      singleItems,
                      searching ? "result" : singleWire.connection,
                      active,
                      setActive,
                    )
                  )
                ) : searching ? (
                  results.length === 0 && authResults.length === 0 ? (
                    <p className="model-empty" role="status">
                      No models match
                    </p>
                  ) : (
                    <>
                      {results.length === 1 && results[0]!.wire.openrouter
                        ? renderChoices(results[0]!.wire, results[0]!.items, "result", active, setActive)
                        : results.map(({ wire, items }) => {
                            const start = resultOffset;
                            resultOffset += items.length;
                            return (
                              <div className="model-group" key={wire.connection} role="group" aria-label={wire.name}>
                                {results.length > 1 ? (
                                  <div className="model-group-label" aria-hidden>
                                    <span>{wire.name}</span>
                                  </div>
                                ) : null}
                                {renderChoices(wire, items, "result", active, setActive, start)}
                              </div>
                            );
                          })}
                      {authResults.map((wire, at) => (
                        <div
                          key={wire.connection}
                          className="model-option provider-option"
                          role="option"
                          id={optionId("auth", at)}
                          aria-selected={false}
                          data-active={active === resultItems.length + at ? "" : undefined}
                          onPointerDown={(event) => event.preventDefault()}
                          onPointerMove={() => {
                            const nextIndex = resultItems.length + at;
                            if (active !== nextIndex) setActive(nextIndex);
                          }}
                          onClick={() => showModels(wire)}
                        >
                          <span className="truncate">{wire.name}</span>
                          <IconChevronRight {...glyph} aria-hidden />
                          <span className="provider-note">Please sign in again.</span>
                        </div>
                      ))}
                    </>
                  )
                ) : (
                  wires.map((wire, index) => {
                    const funds = accountAnnotation(wire.account, now);
                    const lines = accountWindowLines(wire.account, now);
                    const accountTitle = [wire.account.failed ? wire.account.detail : "", funds]
                      .filter((bit) => bit !== "")
                      .join("\n");
                    const statusText = wire.account.needsAuth
                      ? "Please sign in again."
                      : wire.account.failed
                        ? wire.account.description
                        : "";
                    const showAccount = statusText !== "" || wire.account.balance !== "" || lines.length > 0;
                    return (
                      <div
                        className="model-option model-wire"
                        id={wireId(index)}
                        key={wire.connection}
                        role="option"
                        aria-selected={wire === currentWire}
                        aria-haspopup={wire.account.needsAuth ? "menu" : "listbox"}
                        aria-expanded={open === wire.connection}
                        aria-controls={`${id}-submenu-${index}`}
                        data-active={open == null && index === active ? "" : undefined}
                        data-open={open === wire.connection ? "" : undefined}
                        style={anchor(index)}
                        onPointerDown={(event) => event.preventDefault()}
                        onPointerEnter={() => showModels(wire)}
                        onClick={() => showModels(wire)}
                      >
                        <span className="truncate">{wire.name}</span>
                        {showAccount ? (
                          <span className="model-wire-account" title={accountTitle === "" ? undefined : accountTitle}>
                            {statusText !== "" ? (
                              <span data-failed={wire.account.failed ? "" : undefined}>{statusText}</span>
                            ) : lines.length > 0 ? (
                              lines.map((line, at) => (
                                <span
                                  key={`${line.text}:${at}`}
                                  className="model-wire-funds"
                                  data-low={line.low ? "" : undefined}
                                >
                                  {line.text}
                                </span>
                              ))
                            ) : (
                              <span>{wire.account.balance}</span>
                            )}
                          </span>
                        ) : null}
                        <IconChevronRight {...glyph} aria-hidden className="model-wire-chevron shrink-0 text-muted" />
                      </div>
                    );
                  })
                )}
              </div>
              {notice === "" ? null : (
                <p className="model-empty" id={`${id}-notice`} role="alert">
                  {notice}
                </p>
              )}
              {/* Keep the native combobox event contract: SearchField adds Escape-to-clear
                  behavior, while this composite reserves Escape for nested dismissal. */}
              {showSearch ? (
                <div className="flex shrink-0 flex-col p-2 text-sm">
                  <Input
                    id={`${id}-search`}
                    ref={search}
                    type="text"
                    role="combobox"
                    className="model-search"
                    placeholder="Search by model name"
                    aria-label="Search by model name"
                    aria-describedby={notice === "" ? undefined : `${id}-notice`}
                    aria-expanded="true"
                    aria-haspopup={openWire?.account.needsAuth ? "menu" : "listbox"}
                    aria-controls={openWire == null ? `${id}-list` : `${id}-submenu-${wires.indexOf(openWire)}`}
                    aria-activedescendant={activeId}
                    value={query}
                    onChange={(event) => {
                      if (open != null) submenus.current.get(open)?.hidePopover();
                      setQuery(event.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKey}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
        {singleWire == null
          ? wires.map((wire, index) => (
              <div
                key={wire.connection}
                ref={(node) => {
                  if (node == null) submenus.current.delete(wire.connection);
                  else submenus.current.set(wire.connection, node);
                }}
                id={`${id}-submenu-${index}`}
                popover="auto"
                className="model-menu model-submenu"
                role={wire.account.needsAuth ? "menu" : "listbox"}
                aria-label={wire.name}
                style={anchor(index)}
                onKeyDown={(event) => {
                  if (!wire.account.needsAuth) return;
                  const next =
                    event.key === "ArrowDown" || event.key === "End"
                      ? 1
                      : event.key === "ArrowUp" || event.key === "Home"
                        ? 0
                        : null;
                  if (next == null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setSubActive(next);
                  [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")].at(next)?.focus();
                }}
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
                {open === wire.connection && wire.account.needsAuth ? (
                  <>
                    <Button
                      variant="ghost"
                      className="model-option justify-start"
                      role="menuitem"
                      id={optionId(wire.connection, 0)}
                      data-active={subActive === 0 ? "" : undefined}
                      disabled={request == null || removing != null}
                      onPointerMove={() => setSubActive(0)}
                      onClick={() => reconnect(wire)}
                    >
                      Sign in again
                    </Button>
                    <Button
                      variant="ghost"
                      className="model-option justify-start"
                      data-destructive=""
                      role="menuitem"
                      id={optionId(wire.connection, 1)}
                      data-active={subActive === 1 ? "" : undefined}
                      disabled={request == null || removing != null}
                      onPointerMove={() => setSubActive(1)}
                      onClick={() => void remove(wire)}
                    >
                      {removing === wire.connection ? "Deleting…" : "Delete"}
                    </Button>
                  </>
                ) : open === wire.connection ? (
                  renderChoices(
                    wire,
                    preparedByConnection.get(wire.connection) ?? [],
                    wire.connection,
                    subActive,
                    setSubActive,
                  )
                ) : null}
              </div>
            ))
          : null}
      </div>
    </>
  );
}

function prepareChoice(wire: ModelWire, choice: ModelChoice): PreparedChoice {
  const apiName = wire.modelNames?.[choice.model];
  const pricing = wire.modelPricing?.[choice.model];
  const label = naturalName(choice.model, apiName);
  const badges = modelBadges(choice.model, apiName, pricing);
  const priceText = wire.openrouter ? formatModelPricing(pricing, badges) : "";
  const provider = wire.openrouter && choice.model.includes("/") ? openrouterProvider(choice.model) : undefined;
  const vendor = provider?.label ?? "";
  return {
    choice,
    value: modelChoiceValue(choice),
    label,
    badges,
    priceText,
    ...(provider === undefined ? {} : { provider }),
    searchText: `${wire.name} ${vendor} ${choice.model} ${label} ${badges.join(" ")}`.toLowerCase(),
  };
}

const ModelOption = memo(function ({
  id,
  item,
  index,
  selected,
  active,
  onPoint,
  onPick,
}: {
  readonly id: string;
  readonly item: PreparedChoice;
  readonly index: number;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onPoint: (index: number) => void;
  readonly onPick: (choice: ModelChoice) => void;
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
      onPointerMove={() => {
        if (!active) onPoint(index);
      }}
      onClick={() => onPick(item.choice)}
    >
      <div className="model-option-title">
        <span className="truncate">{item.label}</span>
        {item.badges.map((badge) => (
          <span key={badge} className="model-badge">
            {badge}
          </span>
        ))}
      </div>
      <div className="model-option-meta">
        {item.priceText === "" ? null : <span className="model-pricing">{item.priceText}</span>}
        {selected ? <IconCheck {...glyph} aria-hidden className="shrink-0" /> : null}
      </div>
    </div>
  );
});
