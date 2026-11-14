import { useId, type ReactNode } from "react";
import { parseCompactTrigger } from "@inhuman.tools/harness-model/shared";

import { Slider, SliderThumb, SliderTrack, Tooltip } from "../components/ui/index.js";

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

export function SettingsGroup({
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

const PERCENT = { style: "unit", unit: "percent" } as const;

function Header({
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
export function TriggerRange({
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
      <Header id={id} label="Compaction thresholds" hint={hint} readout={`Soft ${soft}% · Hard ${hard}%`} />
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

/** A single share-of-something slider with its readout and explainer. */
export function PercentSlider({
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
      <Header id={id} label={label} hint={hint} readout={`${value}%`} />
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

/** `90%`, `0.9` and `90` name the same share; anything the harness would ignore is null. */
export function percentOf(text: string): number | null {
  const ratio = parseCompactTrigger(text);
  return ratio == null ? null : Math.round(ratio * 100);
}
