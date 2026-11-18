import { useEffect, useId, useState } from "react";
import { DropdownSelect } from "@inhuman.tools/harness-ui/primitives/anchored";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { Checkbox } from "@inhuman.tools/harness-ui/primitives/checkbox";
import { observer } from "mobx-react-lite";

import {
  ask,
  ConnectionRow,
  connectionsOf,
  Empty,
  failureOf,
  Group,
  isWeb,
  isWebOnly,
  listedConnections,
  Notice,
  ParkFollow,
  parkOf,
  report,
  shownName,
  statusLabel,
  Success,
  useConnectionRun,
  useLiveToggle,
  type Conn,
  type Park,
} from "./shared.js";
import { useDial } from "../../client/context.js";

/** Kernel KV keys the daemon's web pick reads (server/drivers/web-search/types.ts). */
const SEARCH_PIN = "web-search-connection";
const EXTRACT_PIN = "web-extract-connection";
const KEYLESS_FALLBACK = "web.keyless_fallback";
const KEYLESS_ID = "web-keyless";
const NOUS_ID = "web-nous";

const AUTO_POLICY = "Auto prefers a provider with your own API key, then the Nous gateway, then the keyless ring.";

type DriverFace = {
  readonly name?: string;
  readonly description?: string;
  readonly abilityClaim?: readonly string[];
};

/** Web search and page extract: who serves each ability, and the providers behind them. */
export const Web = observer(function WebView() {
  const dial = useDial();
  const noticeId = useId();
  const { request, notice, setNotice, success, run, reconnect, flow } = useConnectionRun();
  const [adding, setAdding] = useState(false);
  const [adopting, setAdopting] = useState("");
  const [park, setPark] = useState<Park | null>(null);
  const sessionPort = dial.sessionRpc;
  const kvs = dial.kernel?.root.kvs ?? {};
  const rows = listedConnections(dial);
  const webRows = rows.filter(([, spec]) => isWeb(spec));
  const keyed = webRows.filter(([id, spec]) => isWebOnly(spec) && id !== KEYLESS_ID && id !== NOUS_ID);
  const nous = rows.find(([id]) => id === NOUS_ID);
  const writeKv = (key: string, value: string): Promise<string> => {
    if (sessionPort == null) return Promise.resolve("Open a session to change web routing.");
    return ask((method, params) => sessionPort.request(method, params), "kv/set", { key, value, scope: "kernel" });
  };
  const search = usePin(SEARCH_PIN, (kvs[SEARCH_PIN] ?? "").trim(), writeKv);
  const extract = usePin(EXTRACT_PIN, (kvs[EXTRACT_PIN] ?? "").trim(), writeKv);
  const fallback = useLiveToggle(kvs[KEYLESS_FALLBACK] !== "false", (next) =>
    writeKv(KEYLESS_FALLBACK, next ? "true" : "false"),
  );
  const searchOthers = webRows.filter(
    ([id, spec]) => id !== KEYLESS_ID && spec.driver?.abilityClaim?.includes("web-search"),
  );
  const drivers = (dial.kernel?.root.drivers ?? {}) as Record<string, DriverFace | undefined>;
  const adoptedDrivers = new Set(Object.values(connectionsOf(dial)).map((spec) => spec.driver?.name ?? ""));
  const addable = Object.entries(drivers)
    .map(([key, driver]) => ({ key, driver, name: shownName(driver?.name, key) }))
    .filter(({ driver, name }) => {
      const can = driver?.abilityClaim ?? [];
      return (
        (can.includes("web-search") || can.includes("web-extract")) &&
        !can.includes("completion") &&
        name !== KEYLESS_ID &&
        name !== NOUS_ID &&
        !adoptedDrivers.has(name)
      );
    });
  const addableNames = addable.map(({ name }) => name).join("\0");
  useEffect(() => {
    dial.look([], addableNames === "" ? [] : addableNames.split("\0"));
    return () => dial.look([], []);
  }, [dial, addableNames]);
  const adopt = (driver: string) => {
    if (request == null || adopting !== "") return;
    setNotice("");
    setAdopting(driver);
    void request("connect/adopt", { driver }).then(
      (result) => {
        setAdopting("");
        const next = parkOf(result);
        if (next != null) {
          setPark(next);
          return undefined;
        }
        const failure = failureOf(result);
        setNotice(failure);
        if (failure === "") setAdding(false);
        return undefined;
      },
      (error: unknown) => {
        setAdopting("");
        return report(setNotice, error);
      },
    );
  };
  if (flow != null) return flow;
  if (park != null && request != null) {
    return (
      <ParkFollow
        park={park}
        request={request}
        onPark={setPark}
        onDone={() => {
          setPark(null);
          setAdding(false);
        }}
        onCancel={() => setPark(null)}
      />
    );
  }
  return (
    <>
      <Notice id={noticeId} message={notice} />
      <Success message={success} />
      {sessionPort == null ? <Empty>Open a session to change routing and fallback.</Empty> : null}
      <Group title="Search">
        <PinSelect
          label="Search provider"
          pin={search}
          ability="web-search"
          rows={webRows}
          disabled={sessionPort == null}
        />
        <p className="text-sm text-muted">{AUTO_POLICY}</p>
      </Group>
      <Group title="Page extract">
        <PinSelect
          label="Extract provider"
          pin={extract}
          ability="web-extract"
          rows={webRows}
          disabled={sessionPort == null}
        />
        <p className="text-sm text-muted">{AUTO_POLICY}</p>
      </Group>
      <Group title="Providers">
        <div className="settings-actions">
          <Button
            variant="secondary"
            disabled={request == null}
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
          >
            Add API key
          </Button>
        </div>
        {adding ? (
          <div className="settings-list">
            {addable.length === 0 ? <Empty>Every keyed web provider is already connected.</Empty> : null}
            {addable.map(({ key, driver, name }) => (
              <Button
                key={key}
                variant="ghost"
                className="settings-row items-start text-start [font-variant-caps:normal] tracking-normal"
                disabled={request == null || adopting !== ""}
                onClick={() => adopt(name)}
              >
                <span className="text-sm font-strong">{name}</span>
                <span className="text-sm text-muted">{shownName(driver?.description, "API key")}</span>
              </Button>
            ))}
          </div>
        ) : null}
        <div className="settings-list">
          {keyed.map(([id, spec]) => (
            <ConnectionRow
              key={id}
              id={id}
              spec={spec}
              disabled={request == null}
              onRun={run}
              onReconnect={reconnect}
            />
          ))}
          {nous != null ? <NousRow spec={nous[1]} /> : null}
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-grow">
                <div className="text-sm font-strong">Keyless ring</div>
                <div className="text-sm text-muted">
                  Free public tiers — Exa, Parallel, Firecrawl, Keenable, Tavily. No API key.
                </div>
              </div>
              <Checkbox isSelected={fallback.checked} isDisabled={sessionPort == null} onChange={fallback.toggle}>
                Use as fallback
              </Checkbox>
            </div>
            {!fallback.checked && searchOthers.length === 0 ? (
              <p className="text-sm text-danger" role="status">
                No other web provider is connected. Search and page extract will fail.
              </p>
            ) : null}
          </div>
        </div>
      </Group>
    </>
  );
});

/** The select moves immediately; the kernel KV replaces it when the write lands. */
function usePin(key: string, live: string, write: (key: string, value: string) => Promise<string>) {
  const [override, setOverride] = useState<string | null>(null);
  useEffect(() => {
    if (override !== null && override === live) setOverride(null);
  }, [live, override]);
  const value = override ?? live;
  return {
    value,
    choose: (next: string) => {
      setOverride(next);
      void write(key, next).then((error) => {
        if (error !== "") setOverride(null);
        return undefined;
      });
    },
  };
}

function PinSelect({
  label,
  pin,
  ability,
  rows,
  disabled,
}: {
  readonly label: string;
  readonly pin: { readonly value: string; readonly choose: (next: string) => void };
  readonly ability: "web-search" | "web-extract";
  readonly rows: readonly (readonly [string, Conn])[];
  readonly disabled: boolean;
}) {
  const candidates = rows.filter(([, spec]) => spec.driver?.abilityClaim?.includes(ability));
  const options = [
    { id: "", label: "Auto" },
    ...candidates.map(([id, spec]) => ({ id, label: shownName(spec.name, id) })),
  ];
  if (pin.value !== "" && !candidates.some(([id]) => id === pin.value)) {
    options.push({ id: pin.value, label: `${pin.value} (not connected)` });
  }
  return (
    <DropdownSelect
      label={label}
      className="col-span-full"
      value={pin.value}
      isDisabled={disabled}
      onChange={(value) => pin.choose(value == null ? "" : String(value))}
      options={options}
    />
  );
}

function NousRow({ spec }: { readonly spec: Conn }) {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-grow">
          <div className="text-sm font-strong">Nous gateway</div>
          <div className="text-sm text-muted">Uses your Nous Portal sign-in · {statusLabel(spec.readyState)}</div>
        </div>
      </div>
    </div>
  );
}
