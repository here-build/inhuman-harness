import { createContext, useCallback, useContext } from "react";
import type { Region } from "@here.build/arrival-provenance";
import { isWorkflowLeafMeta, type WorkflowLeafMeta } from "@inhuman.tools/harness-model/session";
import { Outcome } from "@inhuman.tools/harness-transcript";
import { IconChevronRight } from "@tabler/icons-react";

import type { WorkflowCell } from "./cell.js";
import type { Leaf } from "./region-nesting.js";
import { isStructured, valueJson, valueSummary } from "./value-summary.js";
import { verbLabel } from "./verb-label.js";
import { glyph } from "../components/ui/glyph.js";
import { naturalName } from "../shell/model-choice.js";
import type { AgentState } from "../shell/tape-read.js";
import { toolLabel } from "../shell/tool-label.js";

/** Each card hands its element up by id, so the graph can measure what ELK has to place. */
export const MeasureCtx = createContext<(id: number, el: HTMLElement | null) => void>(() => {});

const STATE_WORDS: Readonly<Record<AgentState, string>> = {
  live: "running",
  ok: "done",
  failed: "failed",
  cancelled: "cancelled",
  asking: "awaiting approval",
};

/** The cell is the live truth; the leaf is what the trace settled to. */
export function leafState(leaf: Leaf | Extract<Region, { kind: "output" }>, cell?: WorkflowCell): AgentState {
  if (cell !== undefined) return cell.state;
  return leaf.state === "running" ? "live" : leaf.state === "rejected" ? "failed" : "ok";
}

/** A string is the line. A record or a list is its summary, with JSON behind the disclosure. */
function ValueView({ value, code }: { readonly value: unknown; readonly code?: boolean }) {
  if (!isStructured(value))
    return <p className={code === true ? "wf-preview mono" : "wf-value"}>{valueSummary(value)}</p>;
  return (
    <details className="wf-json">
      <summary>
        <IconChevronRight {...glyph} aria-hidden className="wf-chevron" />
        <span className="wf-summary">{valueSummary(value)}</span>
      </summary>
      <pre className="wf-json-body">{valueJson(value)}</pre>
    </details>
  );
}

const metaOf = (leaf: Leaf): WorkflowLeafMeta =>
  isWorkflowLeafMeta(leaf.meta) ? leaf.meta : { kind: "tool", verb: leaf.label, name: leaf.label };

type CardProps = {
  /** The instance whose call is shown: its message, its value, its cell. */
  readonly leaf: Leaf;
  /** The folded identity wires and layout know the card by; the instance's own id unless a loop folded it. */
  readonly id?: number;
  readonly cell?: WorkflowCell;
  readonly onPick?: (leaf: Leaf) => void;
};

/** An agent or bot is an actor: who, what it was told, how it is going, what it said. A tool is an instrument. */
export function LeafCard({ leaf, id = leaf.id, cell, onPick }: CardProps) {
  const register = useContext(MeasureCtx);
  const ref = useCallback((el: HTMLElement | null) => register(id, el), [register, id]);
  const meta = metaOf(leaf);
  const state = leafState(leaf, cell);
  const value = cell?.value ?? leaf.value;
  const actor = meta.kind !== "tool";
  const status = state === "live" || state === "asking" ? cell?.status : undefined;
  const shownName = actor ? meta.name : toolLabel(meta.name);
  const shownVerb = actor ? meta.verb : verbLabel(toolLabel(meta.verb));
  return (
    <article
      ref={ref}
      className="wf-card"
      data-card={id}
      data-kind={actor ? "actor" : "tool"}
      data-state={state}
      aria-label={`${meta.verb} ${meta.name}, ${STATE_WORDS[state]}`}
    >
      <header className="wf-head">
        {onPick === undefined || !actor ? (
          <span className="wf-name" title={meta.name}>
            {shownName}
          </span>
        ) : (
          <button type="button" className="wf-name wf-pick" title={meta.name} onClick={() => onPick(leaf)}>
            {shownName}
          </button>
        )}
        {meta.model === undefined ? null : <span className="mono wf-model">{naturalName(meta.model)}</span>}
        {meta.verb === meta.name ? null : (
          <span className="label wf-verb" title={shownVerb === meta.verb ? undefined : meta.verb}>
            {shownVerb}
          </span>
        )}
        {state === "live" ? <Outcome outcome="live" /> : null}
      </header>
      {actor && meta.message !== undefined ? (
        <p className="wf-message" data-field="message" data-role="in">
          {meta.message}
        </p>
      ) : null}
      {!actor && meta.args !== undefined
        ? Object.entries(meta.args).map(([key, arg]) => (
            <p
              key={key}
              className="wf-arg mono"
              data-field={key}
              data-role="in"
              title={isStructured(arg) ? valueJson(arg) : undefined}
            >
              <span>{key}</span> {valueSummary(arg)}
            </p>
          ))
        : null}
      {status === undefined || status === "" ? null : <p className="wf-status">{status}</p>}
      {state === "live" || state === "asking" ? null : (
        <div className="wf-result" data-anchor="result">
          {state === "failed" ? (
            <p className="wf-error">
              {valueSummary(typeof cell?.value === "string" ? cell.value : (leaf.error ?? "failed"))}
            </p>
          ) : state === "cancelled" || value === undefined ? null : (
            <ValueView value={value} code={!actor} />
          )}
        </div>
      )}
    </article>
  );
}

/** The program's last value: the one card everything flows into. */
export function OutputCard({ region }: { readonly region: Extract<Region, { kind: "output" }> }) {
  const register = useContext(MeasureCtx);
  const ref = useCallback((el: HTMLElement | null) => register(region.id, el), [register, region.id]);
  const state = leafState(region);
  return (
    <article
      ref={ref}
      className="wf-card"
      data-card={region.id}
      data-kind="output"
      data-state={state}
      aria-label="result"
    >
      <header className="wf-head">
        <span className="label wf-verb">result</span>
        {state === "live" ? <Outcome outcome="live" /> : null}
      </header>
      {state === "live" ? null : (
        <div className="wf-result" data-anchor="result" data-field="" data-role="in">
          {state === "failed" ? <p className="wf-value">failed</p> : <ValueView value={region.value} />}
        </div>
      )}
    </article>
  );
}
